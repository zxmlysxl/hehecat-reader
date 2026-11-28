//! 自动导入 API（管理员鉴权）
//!
//! 挂载在 /reader3 下，沿用 check_manager_auth 校验。

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;

use serde_json::{json, Value};

use super::auth::{check_manager_auth, resolve_namespace};
use super::router::{AppState, ReturnData};

/// 读取配置（轻量，不扫网络，立即返回）
/// POST /reader3/autoImportPreview
pub async fn auto_import_preview(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    _body: Option<axum::body::Bytes>,
) -> Response {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret).into_response(),
    };
    if let Err(ret) = check_manager_auth(&state, &params, &headers, None).await {
        return Json(ret).into_response();
    }

    let cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;
    Json(ReturnData::ok(config_payload(&cfg, &namespace))).into_response()
}

/// 拼装配置响应体（无网络调用）
fn config_payload(
    cfg: &crate::service::auto_import::AutoImportConfig,
    namespace: &str,
) -> Value {
    json!({
        "listUrl": cfg.list_url,
        "lastId": cfg.last_id,
        "enabled": cfg.enabled,
        "scheduleType": match cfg.schedule_type {
            crate::service::auto_import::ScheduleType::Daily => "daily",
            crate::service::auto_import::ScheduleType::Weekly => "weekly",
        },
        "dailyTime": cfg.daily_time,
        "weeklyDays": cfg.weekly_days,
        "autoDeleteInvalid": cfg.auto_delete_invalid,
        "lastRunAt": cfg.last_run_at,
        "lastResult": cfg.last_result,
        "lastImportedCount": cfg.last_imported_count,
        // 后台任务状态（前端轮询用；不扫网络）
        "taskState": cfg.task_state,
        "taskProgress": cfg.task_progress,
        "running": crate::service::auto_import::is_running(namespace),
        "serverTime": chrono::Utc::now().timestamp_millis(),
    })
}

/// 扫描待导入条目（会走网络，前端异步调用，不阻塞区块渲染）
/// POST /reader3/autoImportScan
pub async fn auto_import_scan(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    _body: Option<axum::body::Bytes>,
) -> Response {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret).into_response(),
    };
    if let Err(ret) = check_manager_auth(&state, &params, &headers, None).await {
        return Json(ret).into_response();
    }
    let cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;
    match crate::service::auto_import::scan_pending_async(&cfg).await {
        Ok(ids) => Json(ReturnData::ok(json!({
            "pendingCount": ids.len(),
            "ids": ids.iter().take(50).collect::<Vec<_>>(),
        })))
        .into_response(),
        Err(e) => Json(ReturnData::err(&format!("扫描失败: {e:#}"))).into_response(),
    }
}

/// 启动一次导入（后台异步执行，立即返回，轮询 /autoImportPreview 看进度）
/// POST /reader3/autoImportRun
/// body: { "forceFullScan"?: bool }
pub async fn auto_import_run(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Option<axum::body::Bytes>,
) -> Response {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret).into_response(),
    };
    let body_json = body
        .as_ref()
        .and_then(|b| serde_json::from_slice::<Value>(b).ok());
    if let Err(ret) = check_manager_auth(&state, &params, &headers, body_json.as_ref()).await {
        return Json(ret).into_response();
    }

    let force = body_json
        .as_ref()
        .and_then(|v| v.get("forceFullScan"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let started =
        crate::service::auto_import::spawn_background_import(state.storage.clone(), namespace.clone(), force);
    if !started {
        return Json(ReturnData::ok(json!({
            "started": false,
            "running": true,
            "message": "已有导入任务在运行中",
        })))
        .into_response();
    }

    Json(ReturnData::ok(json!({
        "started": true,
        "running": true,
        "message": "已在后台开始导入，可关闭页面，稍后回来查看结果",
    })))
    .into_response()
}

/// 保存配置
/// POST /reader3/autoImportConfig
pub async fn auto_import_save_config(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: Option<axum::body::Bytes>,
) -> Response {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret).into_response(),
    };
    let body_json = body
        .as_ref()
        .and_then(|b| serde_json::from_slice::<Value>(b).ok());
    if let Err(ret) = check_manager_auth(&state, &params, &headers, body_json.as_ref()).await {
        return Json(ret).into_response();
    }

    let mut cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;
    if let Some(bj) = body_json.as_ref() {
        if let Some(v) = bj.get("enabled").and_then(|v| v.as_bool()) {
            cfg.enabled = v;
        }
        if let Some(v) = bj.get("scheduleType").and_then(|v| v.as_str()) {
            cfg.schedule_type = match v {
                "weekly" => crate::service::auto_import::ScheduleType::Weekly,
                _ => crate::service::auto_import::ScheduleType::Daily,
            };
        }
        if let Some(v) = bj.get("dailyTime").and_then(|v| v.as_str()) {
            let parts: Vec<&str> = v.split(':').collect();
            let h = parts.get(0).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
            let m = parts.get(1).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
            if h > 23 || m > 59 {
                return axum::Json(ReturnData::err("时间格式无效（应为 HH:MM）")).into_response();
            }
            cfg.daily_time = v.to_string();
        }
        if let Some(v) = bj.get("weeklyDays").and_then(|v| v.as_array()) {
            cfg.weekly_days =
                v.iter().filter_map(|d| d.as_u64()).filter(|d| *d <= 6).map(|d| d as u8).collect();
        }
        if let Some(v) = bj.get("autoDeleteInvalid").and_then(|v| v.as_bool()) {
            cfg.auto_delete_invalid = v;
        }
        if let Some(v) = bj.get("listUrl").and_then(|v| v.as_str()) {
            let trimmed = v.trim();
            if trimmed.is_empty() || !trimmed.starts_with("http") {
                return axum::Json(ReturnData::err("列表页地址必须以 http 开头")).into_response();
            }
            cfg.list_url = trimmed.to_string();
        }
    }
    if let Err(e) = crate::service::auto_import::save_config(&state.storage, &namespace, &cfg).await
    {
        return axum::Json(ReturnData::err(&format!("保存失败: {e:#}"))).into_response();
    }

    Json(ReturnData::ok(config_payload(&cfg, &namespace))).into_response()
}
