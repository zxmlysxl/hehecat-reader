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

/// 预览：抓取当前列表页 + 找出待导入的新条目（只预览不写入）
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

    // 预览：扫描待导入的条目（只看不写）
    let pending_ids = match crate::service::auto_import::scan_pending_async(&cfg).await {
        Ok(ids) => ids,
        Err(e) => {
            return axum::Json(ReturnData::err(&format!("预览失败: {e:#}"))).into_response();
        }
    };
    let total_entries = pending_ids.len();

    // 拉取详情页提取 json 地址（只取前 5 条做样例，避免预览耗时过长）
    let mut preview: Vec<Value> = Vec::new();
    for id in pending_ids.iter().take(5) {
        let detail_url = crate::service::auto_import::derive_detail_url(&cfg.list_url, *id);
        match crate::service::auto_import::resolve_json_url_public(&detail_url).await {
            Ok(json_url) => {
                preview.push(json!({
                    "id": id,
                    "detailUrl": detail_url,
                    "jsonUrl": json_url,
                }));
            }
            Err(e) => {
                preview.push(json!({
                    "id": id,
                    "detailUrl": detail_url,
                    "jsonUrl": null,
                    "error": format!("{e:#}"),
                }));
            }
        }
    }

    let payload = json!({
        "listUrl": cfg.list_url,
        "lastId": cfg.last_id,
        "pendingCount": total_entries,
        "preview": preview,
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
    });
    Json(ReturnData::ok(payload)).into_response()
}

/// 执行一次：按增量导入新条目
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

    let mut cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;
    let force = body_json
        .as_ref()
        .and_then(|v| v.get("forceFullScan"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if force {
        cfg.last_id = 0;
    }

    match crate::service::auto_import::run_once(&state.storage, &namespace, &mut cfg).await {
        Ok(result) => {
            let _ =
                crate::service::auto_import::save_config(&state.storage, &namespace, &cfg).await;
            let payload = json!({
                "scanned": result.scanned,
                "importedEntries": result.imported_entries,
                "importedSources": result.imported_sources,
                "lastId": result.last_id,
                "deletedInvalid": result.deleted_invalid,
                "details": result.details,
            });
            Json(ReturnData::ok(payload)).into_response()
        }
        Err(e) => {
            cfg.last_run_at = chrono::Utc::now().timestamp_millis();
            cfg.last_result = format!("失败: {e:#}");
            let _ =
                crate::service::auto_import::save_config(&state.storage, &namespace, &cfg).await;
            axum::Json(ReturnData::err(&format!("自动导入失败: {e:#}"))).into_response()
        }
    }
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

    let payload = json!({
        "enabled": cfg.enabled,
        "scheduleType": match cfg.schedule_type {
            crate::service::auto_import::ScheduleType::Daily => "daily",
            crate::service::auto_import::ScheduleType::Weekly => "weekly",
        },
        "dailyTime": cfg.daily_time,
        "weeklyDays": cfg.weekly_days,
        "autoDeleteInvalid": cfg.auto_delete_invalid,
        "listUrl": cfg.list_url,
        "lastId": cfg.last_id,
        "lastRunAt": cfg.last_run_at,
        "lastResult": cfg.last_result,
        "lastImportedCount": cfg.last_imported_count,
    });
    Json(ReturnData::ok(payload)).into_response()
}
