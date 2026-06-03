//src/routes/rest/status_handler.rs
// by suiGn
// This file defines the status handler for the monad.ai daemon.
// It responds to HTTP GET requests at the /status endpoint with the current environment status.
// It uses the this.env crate to read the environment status stored by the middleware.
// The response includes the status, port, and username in JSON format.
//
// src/routes/rest/status_handler.rs
use actix_web::{get, HttpRequest, HttpResponse, Responder, HttpMessage};
use this_env::EnvStatus;
use serde_json::json;

#[get("/status")]
async fn status(req: HttpRequest) -> impl Responder {
    match req.extensions().get::<EnvStatus>().cloned() {
        Some(env_status) => HttpResponse::Ok().json(env_status),
        None => {
            log::error!("status_handler: No EnvStatus attached to request");
            HttpResponse::InternalServerError().json(json!({
                "error": "EnvStatus not attached to request"
            }))
        }
    }
}