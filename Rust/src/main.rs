// src/main.rs
mod routes; 
mod daemon;
mod utils;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    utils::logger::init();
    daemon::run_daemon().await
}