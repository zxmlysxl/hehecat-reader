//! 远程书源自动导入（定时增量拉取「书源合集」列表页 → 导入新条目）
//!
//! - 场景：书源合集站（如 yckceo 的 /yuedu/shuyuans/）每天新增合集条目，
//!   手工逐个导入太慢。本模块按「增量 id」策略自动跟进。
//! - 增量语义：列表页解析出条目 id（数字递增），只处理 id > last_id 的条目；
//!   处理完把 last_id 更新为最大 id —— 即"上次导入 1347，下次从 1347 之后开始"。
//! - 配置按命名空间存 user_config(ns='autoImport')，管理员可开关与设定间隔。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

use crate::storage::Storage;

/// 用户配置键（user_config.ns）
pub const CFG_KEY: &str = "autoImport";

/// 列表页默认地址
pub const DEFAULT_LIST_URL: &str = "https://www.yckceo.com/yuedu/shuyuans/index.html";

/// 单次最多扫描的列表页数（翻页找新条目）
const MAX_LIST_PAGES: usize = 5;

/// 单次最多导入的合集条目数（防止一次性灌入过多）
const MAX_IMPORT_PER_RUN: usize = 20;

/// 合集详情页 → json 订阅地址
const DETAIL_JSON_RE: &str = r#"https?://[^s"''<>]+.json"#;

/// 列表页条目链接：/yuedu/shuyuans/content/id/1349.html
const LIST_ID_RE: &str = r#"/content/id/(\d+)\.html"#;

/// 自动导入配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoImportConfig {
    /// 总开关
    pub enabled: bool,
    /// 两次执行之间的最小间隔（分钟）
    pub interval_minutes: i64,
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
}

impl Default for AutoImportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 360,
            list_url: DEFAULT_LIST_URL.to_string(),
            last_id: 0,
            last_run_at: 0,
            last_result: String::new(),
            last_imported_count: 0,
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

/// 从合集详情页提取 json 订阅地址
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

/// 执行一次自动导入
pub async fn run_once(storage: &Storage, ns: &str, cfg: &mut AutoImportConfig) -> Result<RunResult> {
    let ids = scan_entry_ids(&cfg.list_url).await?;
    let scanned = ids.len();
    let mut details: Vec<String> = Vec::new();

    // 只处理比 last_id 大的条目（增量）
    let mut pending: Vec<i64> = ids.into_iter().filter(|id| *id > cfg.last_id).collect();
    let max_new = pending.len();
    if pending.len() > MAX_IMPORT_PER_RUN {
        pending.truncate(MAX_IMPORT_PER_RUN);
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

    cfg.last_run_at = chrono::Utc::now().timestamp_millis();
    cfg.last_imported_count = imported_sources as i64;
    cfg.last_result = if imported_entries == 0 {
        if max_new == 0 {
            "无新增条目".to_string()
        } else {
            format!("{max_new} 个新条目均导入失败")
        }
    } else {
        format!("导入 {imported_entries} 个合集 / {imported_sources} 个书源")
    };
    let _ = save_config(storage, ns, cfg).await;

    Ok(RunResult {
        scanned,
        imported_entries,
        imported_sources,
        last_id: cfg.last_id,
        details,
    })
}

/// 由列表页地址推导合集详情页地址
fn derive_detail_url(list_url: &str, id: i64) -> String {
    let base = list_url.split('?').next().unwrap_or(list_url);
    let base = base.trim_end_matches('/');
    // .../yuedu/shuyuans/index.html → .../yuedu/shuyuans/content/id/<id>.html
    if let Some(idx) = base.rfind("/index.html") {
        format!("{}/content/id/{id}.html", &base[..idx])
    } else {
        format!("{base}/content/id/{id}.html")
    }
}

/// 启动定时任务：每 10 分钟检查一次各命名空间的配置，到期则执行
pub fn spawn_auto_import_job(storage: Storage) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(10 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let namespaces = storage.schedule_namespaces().await;
            for ns in namespaces {
                let mut cfg = load_config(&storage, &ns).await;
                if !cfg.enabled {
                    continue;
                }
                let interval_ms = cfg.interval_minutes.clamp(10, 60 * 24 * 7) * 60_000;
                let now = chrono::Utc::now().timestamp_millis();
                if cfg.last_run_at > 0 && now - cfg.last_run_at < interval_ms {
                    continue;
                }
                match run_once(&storage, &ns, &mut cfg).await {
                    Ok(r) => {
                        tracing::info!(
                            "自动导入书源 [{}]: {}（扫描 {} 条）",
                            ns,
                            r.last_id,
                            r.scanned
                        );
                    }
                    Err(e) => {
                        cfg.last_run_at = now;
                        cfg.last_result = format!("失败: {e:#}");
                        let _ = save_config(&storage, &ns, &cfg).await;
                        tracing::warn!("自动导入书源 [{ns}] 失败: {e:#}");
                    }
                }
            }
        }
    });
}
