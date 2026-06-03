use actix_web::{get, Responder, HttpResponse};
use serde_json::json;
use this_me::list_us as list_us_me; // usamos la librería directamente

/// GET /list-us → Always returns JSON
#[get("/list-us")]
pub async fn list_us() -> impl Responder {
    match list_us_me() {
        Ok(identities) => {
            if identities.is_empty() {
                HttpResponse::Ok().json(json!({
                    "status": "not_found",
                    "identities": [],
                    "message": "📭 No identities found."
                }))
            } else {
                HttpResponse::Ok().json(json!({
                    "status": "ok",
                    "identities": identities.into_iter().map(|m| m.username).collect::<Vec<_>>()
                }))
            }
        }
        Err(_) => HttpResponse::InternalServerError().json(json!({
            "status": "error",
            "message": "❌ Failed to read identities directory."
        })),
    }
}