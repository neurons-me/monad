// src/routes/rest/request_history_logs_handler.rs
// by suiGn
// This file defines the request_history_logs handler for the monad.ai daemon.
// It serves the logs HTML file from the this.env crate when a user accesses the /request_history_logs route.
use actix_web::{get, HttpRequest, HttpResponse, Responder};
use this_env::html::serve_logs_html;
#[get("/request_history_logs")]
pub async fn handler(req: HttpRequest) -> impl Responder {
    match serve_logs_html(req.clone()).await {
        Ok(file) => file.into_response(&req),
        Err(_) => HttpResponse::InternalServerError().body("Error loading logs page"),
    }
}