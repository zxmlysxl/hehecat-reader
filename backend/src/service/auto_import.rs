//! 远程书源自动导入（定时增量拉取「书源合集」列表页 → 导入新条目）
//!
//! - 场景：书源合集站（如 yckceo 的 /yuedu/shuyuans/）每天新增合集条目，
//!   手工逐个导入太慢。本模块按「增量 id」策略自动跟进。
//! - 增量语义：列表页解析出条目 id（数字递增），只处理 id > last_id 的条目；
//!   处理完把 last_id 更新为最大 id —— 即"上次导入 1347，下次从 1347 之后开始"。
//! - 配置按命名空间存 user_config(ns='autoImport')，管理员可开关与设定调度。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::storage::Storage;
use futures::StreamExt; // for FuturesUnordered::next()

/// 用户配置键（user_config.ns）
pub const CFG_KEY: &str = "autoImport";

/// 列表页默认地址
pub const DEFAULT_LIST_URL: &str = "https://www.yckceo.com/yuedu/shuyuans/index.html";

/// 单次最多扫描的列表页数（翻页找新条目）
const MAX_LIST_PAGES: usize = 5;

/// 单次最多导入的合集条目数（返回流程的默认页大小；后台任务分批直到导完）
const MAX_IMPORT_PER_RUN: usize = 5;

/// 后台任务单次运行的最长占用时间（留足余量给 web 请求层）
const BACKGROUND_BUDGET_SECS: u64 = 20 * 60;

/// 合集详情页 → json 订阅地址
/// 兼容两种格式：
///   https://www.yckceo.com/yuedu/shuyuans/json/1349.json        （无中间 id 段）
///   https://www.yckceo.com/yuedu/shuyuans/json/id/1349.json     （带中间 id 段，当前实际格式）
/// 旧正则 `[^s"''<>]+` 是排除字符集（排除 s），而 URL 路径含 "shuyuans"（有 s）→ 匹配失败。
const DETAIL_JSON_RE: &str = r#"https?://[\w./?&=%-]*shuyuans/json(?:/id)?/\d+\.json"#;

/// 列表页条目链接：/yuedu/shuyuans/content/id/1349.html
const LIST_ID_RE: &str = r#"/content/id/(\d+)\.html"#;

/// 调度类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleType {
    /// 每天指定时间
    #[default]
    Daily,
    /// 每周指定星期
    Weekly,
}

/// 自动导入配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoImportConfig {
    /// 总开关
    pub enabled: bool,
    /// 调度类型（daily / weekly）
    pub schedule_type: ScheduleType,
    /// 每天指定时间 "HH:MM"（schedule_type=daily 时用）
    pub daily_time: String,
    /// 每周指定星期 0=周一...6=周日（schedule_type=weekly 时用）
    pub weekly_days: Vec<u8>,
    /// 是否自动检测并删除失效源
    pub auto_delete_invalid: bool,
    /// 合集列表页地址
    pub list_url: String,
    /// 上次处理到的最大条目 id（下次只处理比它大的）
    pub last_id: i64,
    /// 上次执行时间（毫秒时间戳）
    pub last_run_at: i64,
    /// 上次执行结果摘要
    pub last_result: String,
    /// 上次导入的书源条数
    pub last_imported_count: i64,
    /// 后台任务状态："" | "running" | "done" | "error"
    #[serde(default)]
    pub task_state: String,
    /// 后台任务进度描述
    #[serde(default)]
    pub task_progress: String,
}

impl Default for AutoImportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            schedule_type: ScheduleType::Daily,
            daily_time: "03:00".to_string(),
            weekly_days: vec![0],
            auto_delete_invalid: false,
            list_url: DEFAULT_LIST_URL.to_string(),
            last_id: 0,
            last_run_at: 0,
            last_result: String::new(),
            last_imported_count: 0,
            task_state: String::new(),
            task_progress: String::new(),
        }
    }
}

/// 单次执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    /// 扫描到的条目 id
    pub scanned: usize,
    /// 本次导入的合集条目数
    pub imported_entries: usize,
    /// 本次写入的书源条数
    pub imported_sources: usize,
    /// 更新后的 last_id
    pub last_id: i64,
    /// 每个条目的处理明细
    pub details: Vec<String>,
    /// 本次删除的失效源数量（auto_delete_invalid 开启时）
    pub deleted_invalid: usize,
}

/// 读取命名空间的自动导入配置
pub async fn load_config(storage: &Storage, ns: &str) -> AutoImportConfig {
    match storage.get_user_config(ns, CFG_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => AutoImportConfig::default(),
    }
}

/// 保存命名空间的自动导入配置
pub async fn save_config(
    storage: &Storage,
    ns: &str,
    cfg: &AutoImportConfig,
) -> Result<()> {
    let raw = serde_json::to_string(cfg)?;
    storage.save_user_config(ns, CFG_KEY, &raw).await
}

/// 抓取列表页，解析出所有条目 id（升序去重）
async fn scan_entry_ids(list_url: &str) -> Result<Vec<i64>> {
    let headers: HashMap<String, String> = HashMap::new();
    let mut ids: Vec<i64> = Vec::new();
    let re = crate::util::regex::Regex::new(LIST_ID_RE)
        .map_err(|e| anyhow::anyhow!("列表页正则无效: {e}"))?;

    for page in 1..=MAX_LIST_PAGES {
        let url = if page == 1 {
            list_url.to_string()
        } else {
            // 站点分页形如 index.html?page=2
            let sep = if list_url.contains('?') { '&' } else { '?' };
            format!("{list_url}{sep}page={page}")
        };
        let resp = match crate::service::crawler::fetch(&url, &headers, 30, "GET", None, None, None)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                if page == 1 {
                    return Err(anyhow::anyhow!("抓取列表页失败: {e:#}"));
                }
                break;
            }
        };
        let body: String = resp.body;
        let mut found = 0usize;
        for cap in re.captures_iter(&body) {
            if let Some(m) = cap.get(1) {
                if let Ok(id) = m.as_str().parse::<i64>() {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                    found += 1;
                }
            }
        }
        // 首页就没解析出条目 → 页面结构变了，停止翻页
        if found == 0 {
            break;
        }
    }
    ids.sort_unstable();
    Ok(ids)
}

/// 从合集详情页提取 json 订阅地址（内部用）
async fn resolve_json_url(detail_url: &str) -> Result<String> {
    let headers: HashMap<String, String> = HashMap::new();
    let resp =
        crate::service::crawler::fetch(detail_url, &headers, 30, "GET", None, None, None)
            .await
            .map_err(|e| anyhow::anyhow!("抓取详情页失败: {e:#}"))?;
    let re = crate::util::regex::Regex::new(DETAIL_JSON_RE)
        .map_err(|e| anyhow::anyhow!("详情页正则无效: {e}"))?;
    let body: String = resp.body;
    let found = re
        .captures_iter(&body)
        .next()
        .and_then(|cap| cap.get(0).map(|m| m.as_str().to_string()))
        .filter(|s| !s.is_empty());
    match found {
        Some(url) => Ok(url),
        None => Err(anyhow::anyhow!("详情页未找到 json 地址")),
    }
}

/// 公开：扫描待导入条目（只读不写，供预览）
/// 同步壳仅为占位；调用方应使用异步版 scan_pending_async。
pub fn scan_pending(_cfg: &AutoImportConfig) -> Result<Vec<i64>> {
    anyhow::bail!("请使用异步版 scan_pending_async")
}

/// 公开：扫描待导入条目（异步版）
pub async fn scan_pending_async(cfg: &AutoImportConfig) -> Result<Vec<i64>> {
    let ids = scan_entry_ids(&cfg.list_url).await?;
    Ok(ids.into_iter().filter(|id| *id > cfg.last_id).collect())
}

/// 公开：从详情页解析 json 地址
pub async fn resolve_json_url_public(detail_url: &str) -> Result<String> {
    resolve_json_url(detail_url).await
}

/// 检测并删除失效源，返回删除数量
async fn check_and_delete_invalid(
    storage: &Storage,
    ns: &str,
) -> Result<usize> {
    let sources: Vec<crate::model::BookSource> =
        storage.get_book_sources(ns).await?.into_iter().filter(|s| s.enabled).collect();
    let total = sources.len();
    tracing::debug!("check_and_delete_invalid [{ns}] 启用源总数: {total}");
    let concurrency: usize = std::env::var("READER_CHECK_SOURCES_CONCURRENCY")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(32)
        .clamp(1, 128);
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(concurrency));
    let mut tasks = futures::stream::FuturesUnordered::new();
    for source in sources.into_iter() {
        let sem = semaphore.clone();
        let nsx = ns.to_string();
        tasks.push(Box::pin(async move {
            let _permit = sem.acquire().await;
            let (ok, _reason) =
                crate::service::health::check_source(&nsx, &source).await;
            (source, ok)
        }));
    }
    let mut deleted = 0usize;
    while let Some((source, ok)) = tasks.next().await {
        if ok {
            crate::service::health::clear_source_invalid(ns, &source.book_source_url);
        } else {
            crate::service::health::mark_source_invalid(ns, &source.book_source_url, "自动检测失效");
        }
    }
    // 删除已标记失效的
    let snapshot = crate::service::health::invalid_snapshot(ns);
    for (url, _time, _err) in snapshot {
        if storage.delete_book_source(ns, &url).await.is_ok() {
            deleted += 1;
            crate::service::health::clear_source_invalid(ns, &url);
        }
    }
    Ok(deleted)
}

/// 执行一次自动导入
pub async fn run_once(storage: &Storage, ns: &str, cfg: &mut AutoImportConfig) -> Result<RunResult> {
    run_with_limit(storage, ns, cfg, MAX_IMPORT_PER_RUN).await
}

/// 执行一次自动导入（带条目上限）
pub async fn run_with_limit(
    storage: &Storage,
    ns: &str,
    cfg: &mut AutoImportConfig,
    limit: usize,
) -> Result<RunResult> {
    let ids = scan_entry_ids(&cfg.list_url).await?;
    let scanned = ids.len();
    let mut details: Vec<String> = Vec::new();

    // 只处理比 last_id 大的条目（增量）
    let mut pending: Vec<i64> = ids.into_iter().filter(|id| *id > cfg.last_id).collect();
    let max_new = pending.len();
    if pending.len() > limit {
        pending.truncate(limit);
    }

    let mut imported_entries = 0usize;
    let mut imported_sources = 0usize;
    let headers: HashMap<String, String> = HashMap::new();

    for id in pending {
        // 详情页地址由列表页地址推导（同目录 content/id/<id>.html）
        let detail_url = derive_detail_url(&cfg.list_url, id);
        let json_url = match resolve_json_url(&detail_url).await {
            Ok(u) => u,
            Err(e) => {
                details.push(format!("#{id} 跳过: {e:#}"));
                continue;
            }
        };
        let resp =
            match crate::service::crawler::fetch(&json_url, &headers, 60, "GET", None, None, None)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    details.push(format!("#{id} 下载失败: {e:#}"));
                    continue;
                }
            };
        let json: serde_json::Value = match serde_json::from_str(&resp.body) {
            Ok(v) => v,
            Err(e) => {
                details.push(format!("#{id} JSON 解析失败: {e}"));
                continue;
            }
        };
        let sources = crate::model::book_source::normalize_book_sources(json);
        if sources.is_empty() {
            details.push(format!("#{id} 无有效书源"));
            continue;
        }
        let count = sources.len();
        if let Err(e) = storage.save_book_sources(ns, &sources).await {
            details.push(format!("#{id} 写入失败: {e}"));
            continue;
        }
        imported_entries += 1;
        imported_sources += count;
        details.push(format!("#{id} 导入 {count} 个书源"));
        // 已成功导入的条目才推进 last_id（失败的条目下次重试）
        cfg.last_id = cfg.last_id.max(id);
    }

    // 自动检测并删除失效源
    let mut deleted_invalid = 0usize;
    if cfg.auto_delete_invalid {
        match check_and_delete_invalid(storage, ns).await {
            Ok(n) => {
                deleted_invalid = n;
                details.push(format!("检测并删除 {n} 个失效源"));
            }
            Err(e) => {
                details.push(format!("失效源检测失败: {e:#}"));
            }
        }
    }

    cfg.last_run_at = chrono::Utc::now().timestamp_millis();
    cfg.last_imported_count = imported_sources as i64;
    let import_summary = if imported_entries == 0 {
        if max_new == 0 {
            "无新增条目".to_string()
        } else {
            format!("{max_new} 个新条目本次均未导入成功")
        }
    } else if max_new > limit {
        format!(
            "导入 {imported_entries} 个合集 / {imported_sources} 个书源（还有 {} 个待导入）",
            max_new - imported_entries
        )
    } else {
        format!("导入 {imported_entries} 个合集 / {imported_sources} 个书源")
    };
    cfg.last_result = if cfg.auto_delete_invalid && deleted_invalid > 0 {
        format!("{import_summary}；删除 {deleted_invalid} 个失效源")
    } else {
        import_summary
    };
    let _ = save_config(storage, ns, cfg).await;

    Ok(RunResult {
        scanned,
        imported_entries,
        imported_sources,
        last_id: cfg.last_id,
        details,
        deleted_invalid,
    })
}

/// 由列表页地址推导合集详情页地址
pub fn derive_detail_url(list_url: &str, id: i64) -> String {
    let base = list_url.split('?').next().unwrap_or(list_url);
    let base = base.trim_end_matches('/');
    // .../yuedu/shuyuans/index.html → .../yuedu/shuyuans/content/id/<id>.html
    if let Some(idx) = base.rfind("/index.html") {
        format!("{}/content/id/{id}.html", &base[..idx])
    } else {
        format!("{base}/content/id/{id}.html")
    }
}

/// 判断当前时刻是否应触发执行（基于配置的时间调度）
/// now: 本地时间
fn should_run_at(cfg: &AutoImportConfig, now: &chrono::DateTime<chrono::Local>) -> bool {
    // 当前是否落在配置的执行时间窗口（10 分钟粒度）
    let (h, m) = parse_hm(&cfg.daily_time);
    let now_h = now.format("%H").to_string().parse::<u32>().unwrap_or(0);
    let now_m = now.format("%M").to_string().parse::<u32>().unwrap_or(0);
    // 不在窗口内 → 不触发
    if now_h != h || now_m < m || now_m >= m + 10 {
        return false;
    }
    // weekly 模式：检查今天星期是否在 weekly_days
    if let ScheduleType::Weekly = cfg.schedule_type {
        let weekday = now.format("%u").to_string().parse::<u8>().unwrap_or(0).saturating_sub(1); // 0=Mon..6=Sun
        if !cfg.weekly_days.iter().any(|d| *d == weekday) {
            return false;
        }
    }
    // 检查今天是否已跑过（last_run_at 同一天 → 跳过）
    if cfg.last_run_at > 0 {
        let now_date = now.format("%Y-%m-%d").to_string();
        let last_date: chrono::DateTime<chrono::Local> =
            chrono::DateTime::from(chrono::TimeZone::timestamp_millis(&chrono::Local, cfg.last_run_at));
        if last_date.format("%Y-%m-%d").to_string() == now_date {
            return false;
        }
    }
    true
}

fn parse_hm(s: &str) -> (u32, u32) {
    let parts: Vec<&str> = s.split(':').collect();
    let h = parts.get(0).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    let m = parts.get(1).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    (h, m)
}

/// 启动定时任务：每 10 分钟检查一次各命名空间的配置，到期则执行
pub fn spawn_auto_import_job(storage: Storage) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let now = chrono::Local::now();
            let namespaces = storage.schedule_namespaces().await;
            for ns in namespaces {
                let mut cfg = load_config(&storage, &ns).await;
                if !cfg.enabled {
                    continue;
                }
                if !should_run_at(&cfg, &now) {
                    continue;
                }
                match run_once(&storage, &ns, &mut cfg).await {
                    Ok(r) => {
                        tracing::info!(
                            "自动导入书源 [{}]: {}（扫描 {} 条，删除 {} 个失效源）",
                            ns,
                            r.last_id,
                            r.scanned,
                            r.deleted_invalid
                        );
                    }
                    Err(e) => {
                        cfg.last_run_at = chrono::Utc::now().timestamp_millis();
                        cfg.last_result = format!("失败: {e:#}");
                        let _ = save_config(&storage, &ns, &cfg).await;
                        tracing::warn!("自动导入书源 [{ns}] 失败: {e:#}");
                    }
                }
            }
        }
    });
}

/// 正在跑后台任务的命名空间（防止重复触发）
static RUNNING: std::sync::OnceLock<parking_lot::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn running_set() -> &'static parking_lot::Mutex<std::collections::HashSet<String>> {
    RUNNING.get_or_init(|| parking_lot::Mutex::new(std::collections::HashSet::new()))
}

/// 查询某命名空间是否正在跑后台导入
pub fn is_running(ns: &str) -> bool {
    running_set().lock().contains(ns)
}

/// 后台分批导入：立即返回，任务在 tokio 里继续跑，进度写入 cfg(task_state/task_progress)
/// `force_full` 为 true 时把游标归零（全量重扫）
pub fn spawn_background_import(storage: Storage, ns: String, force_full: bool) -> bool {
    {
        let mut set = running_set().lock();
        if set.contains(&ns) {
            return false; // 已有任务在跑
        }
        set.insert(ns.clone());
    }

    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let mut cfg = load_config(&storage, &ns).await;
        if force_full {
            cfg.last_id = 0;
        }
        cfg.task_state = "running".to_string();
        cfg.task_progress = "正在扫描列表页…".to_string();
        let _ = save_config(&storage, &ns, &cfg).await;

        let mut total_entries = 0usize;
        let mut total_sources = 0usize;
        let mut rounds = 0usize;
        let mut last_error: Option<String> = None;

        loop {
            rounds += 1;
            let mut c = load_config(&storage, &ns).await;
            match run_with_limit(&storage, &ns, &mut c, MAX_IMPORT_PER_RUN).await {
                Ok(r) => {
                    total_entries += r.imported_entries;
                    total_sources += r.imported_sources;

                    c.task_state = "running".to_string();
                    c.task_progress = format!(
                        "已导入 {total_entries} 个合集 / {total_sources} 个书源（第 {rounds} 轮）"
                    );
                    let _ = save_config(&storage, &ns, &c).await;

                    // 本轮没有导入任何新条目 → 导完了或全部失败，收工
                    if r.imported_entries == 0 {
                        break;
                    }
                    if started.elapsed().as_secs() > BACKGROUND_BUDGET_SECS {
                        break;
                    }
                }
                Err(e) => {
                    last_error = Some(format!("{e:#}"));
                    break;
                }
            }
        }

        let mut final_cfg = load_config(&storage, &ns).await;
        final_cfg.task_state = if last_error.is_some() { "error" } else { "done" }.to_string();
        final_cfg.task_progress = match &last_error {
            Some(e) => format!("失败: {e}"),
            None => {
                if total_entries == 0 {
                    "无新增条目".to_string()
                } else {
                    format!("完成：导入 {total_entries} 个合集 / {total_sources} 个书源")
                }
            }
        };
        let _ = save_config(&storage, &ns, &final_cfg).await;

        running_set().lock().remove(&ns);
        tracing::info!(
            "后台自动导入 [{}] 结束: {} 个合集 / {} 个书源，{} 轮",
            ns,
            total_entries,
            total_sources,
            rounds
        );
    });

    true
}
