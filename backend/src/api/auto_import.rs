//! 远程书源自动导入 API（管理员）
//!
//! - GET  /reader3/getAutoImportConfig   读取配置（开关/间隔/列表页/上次 id）
//! - POST /reader3/setAutoImportConfig   修改配置
//! - POST /reader3/runAutoImportNow      立即执行一次

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::Value;

use super::auth::{check_manager_auth, resolve_namespace};
use super::router::{param_of, AppState, ReturnData};

/// GET/POST /reader3/getAutoImportConfig: 读取自动导入配置
pub async fn get_auto_import_config(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Json<ReturnData> {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret),
    };
    if let Err(ret) = check_manager_auth(&state, &params, &headers, None).await {
        return Json(ret);
    }
    let cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;
    Json(ReturnData::ok(serde_json::to_value(cfg).unwrap_or(Value::Null)))
}

/// POST /reader3/setAutoImportConfig: 开关 / 执行间隔 / 列表页地址
pub async fn set_auto_import_config(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Option<axum::body::Bytes>,
) -> Json<ReturnData> {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret),
    };
    let body_json = body
        .as_ref()
        .and_then(|b| serde_json::from_slice::<Value>(b).ok());
    if let Err(ret) = check_manager_auth(&state, &params, &headers, body_json.as_ref()).await {
        return Json(ret);
    }
    let mut cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;

    let enabled_raw = param_of(&params, body_json.as_ref(), "enabled");
    if !enabled_raw.is_empty() {
        match enabled_raw.parse::<bool>() {
            Ok(v) => cfg.enabled = v,
            Err(_) => return Json(ReturnData::err("enabled 必须为布尔值")),
        }
    }

    let interval_raw = param_of(&params, body_json.as_ref(), "intervalMinutes");
    if !interval_raw.is_empty() {
        match interval_raw.parse::<i64>() {
            Ok(v) => cfg.interval_minutes = v.clamp(10, 60 * 24 * 7),
            Err(_) => return Json(ReturnData::err("intervalMinutes 必须为整数")),
        }
    }

    let list_url = param_of(&params, body_json.as_ref(), "listUrl");
    if !list_url.trim().is_empty() {
        let v = list_url.trim();
        if !(v.starts_with("http://") || v.starts_with("https://")) {
            return Json(ReturnData::err("列表页地址必须以 http:// 或 https:// 开头"));
        }
        cfg.list_url = v.to_string();
    }

    if let Err(e) = crate::service::auto_import::save_config(&state.storage, &namespace, &cfg).await
    {
        tracing::error!("保存自动导入配置失败: {e}");
        return Json(ReturnData::err("保存失败"));
    }
    Json(ReturnData::ok(serde_json::to_value(cfg).unwrap_or(Value::Null)))
}

/// POST /reader3/runAutoImportNow: 立即执行一次
pub async fn run_auto_import_now(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Json<ReturnData> {
    let namespace = match resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret),
    };
    if let Err(ret) = check_manager_auth(&state, &params, &headers, None).await {
        return Json(ret);
    }
    let mut cfg = crate::service::auto_import::load_config(&state.storage, &namespace).await;
    match crate::service::auto_import::run_once(&state.storage, &namespace, &mut cfg).await {
        Ok(r) => Json(ReturnData::ok(serde_json::to_value(r).unwrap_or(Value::Null))),
        Err(e) => {
            tracing::warn!("手动执行自动导入失败 [{namespace}]: {e:#}");
            Json(ReturnData::err(format!("执行失败: {e:#}")))
        }
    }
}
