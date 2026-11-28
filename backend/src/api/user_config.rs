//! 用户配置持久化（阅读设置等）

use super::router::ReturnData;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;

/// GET /reader3/userConfig — 读取当前用户配置
pub async fn get_user_config(
    State(state): State<super::router::AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let namespace = match super::auth::resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret).into_response(),
    };

    let key = "prefs";
    match state.storage.get_user_config(&namespace, key).await {
        Ok(Some(v)) => Json(ReturnData::ok(
            serde_json::from_str(&v).unwrap_or_default(),
        ))
        .into_response(),
        Ok(None) => Json(ReturnData::ok(serde_json::json!({}))).into_response(),
        Err(e) => Json(ReturnData::err(&format!("读取失败: {e}"))).into_response(),
    }
}

/// POST /reader3/saveUserConfig — 保存当前用户配置
pub async fn save_user_config(
    State(state): State<super::router::AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let namespace = match super::auth::resolve_namespace(&state, &params, &headers).await {
        Ok(ns) => ns,
        Err(ret) => return Json(ret).into_response(),
    };

    let key = "prefs";
    let json_str = match serde_json::to_string(&body) {
        Ok(s) => s,
        Err(e) => return Json(ReturnData::err(&format!("序列化失败: {e}"))).into_response(),
    };
    match state.storage.save_user_config(&namespace, key, &json_str).await {
        Ok(()) => Json(ReturnData::ok(serde_json::json!({ "ok": true }))).into_response(),
        Err(e) => Json(ReturnData::err(&format!("保存失败: {e}"))).into_response(),
    }
}
