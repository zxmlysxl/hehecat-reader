//! 书源健康检测（getInvalidBookSources）：持久化失效书源快照 + 并发 HEAD/首页检测

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use crate::model::BookSource;
use crate::service::crawler;

/// 失效书源持久化 TTL：24 小时（重启后保留，跨浏览器共享）
const INVALID_SNAPSHOT_TTL_MS: i64 = 24 * 3600 * 1000;

/// 内存热缓存（避免高频读 DB）；DB 是权威来源
static INVALID_SOURCE_HOT: LazyLock<Mutex<HashMap<String, (i64, String)>>> =
    LazyLock::new(Default::default);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 标记书源失效：写 DB + 内存热缓存。
/// 需在 async 上下文中调用（Storage 通过 task_local 获取）。
pub async fn mark_source_invalid(ns: &str, source_url: &str, error_msg: &str) {
    let ts = now_ms();
    {
        let mut map = INVALID_SOURCE_HOT.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(format!("{ns}:{source_url}"), (ts, error_msg.to_string()));
    }
    if let Some(storage) = crate::storage::current_task_storage() {
        let _ = storage.mark_invalid_source(ns, source_url, error_msg, ts).await;
    }
}

/// 成功抓取后清除失败标记：删 DB + 内存
pub async fn clear_source_invalid(ns: &str, source_url: &str) {
    {
        let mut map = INVALID_SOURCE_HOT.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&format!("{ns}:{source_url}"));
    }
    if let Some(storage) = crate::storage::current_task_storage() {
        let _ = storage.clear_invalid_source(ns, source_url).await;
    }
}

/// 判断书源是否处于 24h 失效期内（搜索等请求前置短路用）
/// 先查内存热缓存，miss 时查 DB。
pub async fn is_source_invalid(ns: &str, source_url: &str) -> bool {
    {
        let map = INVALID_SOURCE_HOT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((ts, _)) = map.get(&format!("{ns}:{source_url}")) {
            if now_ms() - *ts < INVALID_SNAPSHOT_TTL_MS {
                return true;
            }
        }
    }
    if let Some(storage) = crate::storage::current_task_storage() {
        return storage.is_invalid_source(ns, source_url, now_ms()).await;
    }
    false
}

/// 读取命名空间下 24h 内的失效记录（DB + 内存合并，过期清理）
/// → [(sourceUrl, time, errorMsg)]
pub async fn invalid_snapshot(ns: &str) -> Vec<(String, i64, String)> {
    let now = now_ms();
    // 从 DB 读
    let mut out: Vec<(String, i64, String)> = if let Some(storage) = crate::storage::current_task_storage() {
        storage.get_invalid_sources(ns, now - INVALID_SNAPSHOT_TTL_MS).await
    } else {
        Vec::new()
    };
    // 合并内存热缓存（可能比 DB 更新）
    {
        let map = INVALID_SOURCE_HOT.lock().unwrap_or_else(|e| e.into_inner());
        let prefix = format!("{ns}:");
        for (k, (ts, err)) in map.iter().filter(|(k, (ts, _))| now - *ts < INVALID_SNAPSHOT_TTL_MS) {
            if k.starts_with(&prefix) {
                let url = k[prefix.len()..].to_string();
                if !out.iter().any(|(u, _, _)| *u == url) {
                    out.push((url, *ts, err.clone()));
                }
            }
        }
    }
    out.sort_by_key(|x| std::cmp::Reverse(x.1));
    out
}
/// 单书源健康检测：HEAD 优先（405/501 或失败回退 GET 首页）
/// 返回 (是否可用, 说明)
pub async fn check_source(_ns: &str, source: &BookSource) -> (bool, String) {
    let base = source
        .book_source_url
        .split("##")
        .next()
        .unwrap_or("")
        .trim();
    if base.is_empty() {
        return (false, "书源地址为空".to_string());
    }
    // P1 SSRF：书源地址公网校验（DNS 解析后——拒绝私网/回环/169.254 等）
    if let Err(e) = crate::service::crawler::validate_public_target(base).await {
        return (false, format!("地址校验失败: {e}"));
    }
    let headers = source
        .header
        .as_deref()
        .map(crawler::parse_header)
        .unwrap_or_default();
    let client = crawler::shared_http_client();
    let req_timeout = Duration::from_secs(8);
    let req_headers = to_reqwest_headers(&headers);

    // HEAD 优先（轻量）
    let head = client
        .head(base)
        .timeout(req_timeout)
        .headers(req_headers.clone())
        .send()
        .await;
    if let Ok(resp) = head {
        let status = resp.status().as_u16();
        if status == 405 || status == 501 {
            // 服务器不支持 HEAD → GET 兜底
        } else if status < 400 {
            return (true, format!("HEAD {status}"));
        } else {
            // 4xx/5xx：不视为“网络失效”，但按不可用处理（GET 兜底验证首页）
            let get = client
                .get(base)
                .timeout(req_timeout)
                .headers(req_headers.clone())
                .send()
                .await;
            return match get {
                Ok(r) if r.status().as_u16() < 400 => {
                    (true, format!("GET {}", r.status().as_u16()))
                }
                Ok(r) => (false, format!("HTTP {}", r.status().as_u16())),
                Err(e) => (false, format!("连接失败: {e}")),
            };
        }
    }
    // GET 兜底
    match client
        .get(base)
        .timeout(req_timeout)
        .headers(req_headers)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status < 400 {
                (true, format!("GET {status}"))
            } else {
                (false, format!("HTTP {status}"))
            }
        }
        Err(e) => (false, format!("连接失败: {e}")),
    }
}

/// 并发检测全部书源（并发上限 96——6900+ 书源时 8 并发会拖到小时级并触发前端 15s 超时）；
/// 返回不可用列表 [(书源, 原因)]
pub async fn find_invalid(ns: &str, sources: &[BookSource]) -> Vec<(BookSource, String)> {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(96));
    let mut handles = Vec::with_capacity(sources.len());
    for source in sources {
        let sem = semaphore.clone();
        let ns = ns.to_string();
        let source = source.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            check_source(&ns, &source).await
        }));
    }
    let mut invalid = Vec::new();
    for (source, h) in sources.iter().zip(handles) {
        if let Ok((ok, reason)) = h.await {
            if !ok {
                invalid.push((source.clone(), reason));
            }
        }
    }
    invalid
}

/// HashMap<String,String> → http::HeaderMap（非法头名/值跳过）
fn to_reqwest_headers(headers: &HashMap<String, String>) -> http::HeaderMap {
    let mut hm = http::HeaderMap::new();
    for (k, v) in headers {
        if let (Ok(k), Ok(v)) = (
            http::header::HeaderName::try_from(k.as_str()),
            http::header::HeaderValue::try_from(v.as_str()),
        ) {
            hm.insert(k, v);
        }
    }
    hm
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 运行期失效快照：标记 → 快照返回；清除 → 消失；命名空间隔离
    #[test]
    fn test_invalid_snapshot_mark_clear() {
        let ns = "snap-test-a";
        mark_source_invalid(ns, "http://a.com", "连接失败");
        let snap = invalid_snapshot(ns);
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].0, "http://a.com");
        assert!(snap[0].1 > 0);
        assert!(snap[0].2.contains("连接失败"));
        // 命名空间隔离
        assert!(invalid_snapshot("snap-test-b").is_empty());
        // 前置短路查询：标记期内为 true，清除后为 false，跨命名空间不受影响
        assert!(is_source_invalid(ns, "http://a.com"));
        assert!(!is_source_invalid("snap-test-b", "http://a.com"));
        // 成功抓取清除
        clear_source_invalid(ns, "http://a.com");
        assert!(invalid_snapshot(ns).is_empty());
        assert!(!is_source_invalid(ns, "http://a.com"));
    }

    /// 过期条目不返回（600 秒 TTL）
    #[test]
    fn test_invalid_snapshot_expires() {
        let ns = "snap-test-expire";
        let key = snapshot_key(ns, "http://old.com");
        INVALID_SOURCE_SNAPSHOT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                key,
                (now_ms() - INVALID_SNAPSHOT_TTL_MS - 1000, "过期".into()),
            );
        assert!(invalid_snapshot(ns).is_empty(), "超过 600 秒的记录应被清理");
        assert!(!is_source_invalid(ns, "http://old.com"), "过期记录不短路");
    }

    #[test]
    fn test_to_reqwest_headers_skips_invalid() {
        let mut map = HashMap::new();
        map.insert("User-Agent".to_string(), "UA1".to_string());
        map.insert("bad header name".to_string(), "x".to_string());
        let hm = to_reqwest_headers(&map);
        assert_eq!(hm.len(), 1);
        assert_eq!(hm.get("user-agent").unwrap(), "UA1");
    }

    #[tokio::test]
    async fn test_check_source_empty_url() {
        let src = BookSource::default();
        let (ok, reason) = check_source("default", &src).await;
        assert!(!ok);
        assert!(reason.contains("书源地址为空"));
    }

    #[tokio::test]
    async fn test_check_source_unreachable() {
        // 127.0.0.1:1 连接拒绝 → 不可用（快速失败）
        let src = BookSource {
            book_source_url: "http://127.0.0.1:1".into(),
            book_source_name: "坏源".into(),
            ..Default::default()
        };
        let (ok, reason) = check_source("default", &src).await;
        assert!(!ok, "不可达应判定不可用: {reason}");
    }

    /// P1 SSRF：书源健康检测地址拒绝私网/回环（DNS 解析后校验，错误返回）
    #[tokio::test]
    async fn test_check_source_rejects_private_url() {
        let _g = crate::service::crawler::ssrf_allow_private_guard(false);
        for url in [
            "http://127.0.0.1:8080",
            "http://10.0.0.1",
            "http://169.254.169.254/latest/meta-data",
        ] {
            let src = BookSource {
                book_source_url: url.into(),
                book_source_name: "私网源".into(),
                ..Default::default()
            };
            let (ok, reason) = check_source("default", &src).await;
            assert!(!ok, "私网地址应判定不可用");
            assert!(reason.contains("已拦截"), "应报内网拦截（{url}）: {reason}");
        }
    }
}
