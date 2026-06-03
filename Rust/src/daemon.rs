//monad.ai/crate/src/daemon.rs
// This file is part of monad.ai, a project for building AI applications.
use std::env;
use actix_web::{App, HttpServer, web};
use crate::routes::router;
use crate::routes::graphql; // Import for GraphQL schema
// Import this.env middleware for actix
// this.env intercepts all requests for dataStructure analysis and logging.
use this_env::{ThisEnvMiddleware, ThisEnvMiddlewareConfig};
//CORS to accept requests from any origin to the instance running.
fn cors_permissive() -> actix_cors::Cors {
    actix_cors::Cors::default()
        .allow_any_origin()
        .allow_any_method()
        .allow_any_header()
        .supports_credentials()
}

pub async fn run_daemon() -> std::io::Result<()> {
let port = env::var("PORT").unwrap_or_else(|_| "7777".to_string());
// Reads the instance name from an environment variable so different instances (e.g., dev, prod) 
// can run without changing the code. Defaults to "default" if not set.
//Start as: PORT=7778 monad.ai=dev cargo run.  -> monad.ai is the name of the enviroment variable.
let instance = env::var("monad.ai").unwrap_or_else(|_| "default".to_string()); //the name of the instance for this monad.
// Clones para mover dentro del closure
let port_clone = port.clone();
let instance_clone = instance.clone();
//THIS.ENV Actix MiddleWare Configuration
//We pass the port and instance
//to the ActixMiddleware configuration so that this.env can differentiate 
//its database and runtime context per running instance/port.
let mw_config = ThisEnvMiddlewareConfig {
    port: port_clone.clone(),
    instance: instance_clone.clone(),
    ..Default::default()
};

let schema = web::Data::new(graphql::create_schema());
println!("⊙ Starting monad.ai ({}) at http://localhost:{}...", instance, port);
HttpServer::new(move || {
    let mw_config_clone = mw_config.clone();
    App::new()
        .app_data(schema.clone())        // GraphQL usa el mismo AppState
        .wrap(cors_permissive())
        .wrap(ThisEnvMiddleware::new(mw_config_clone))
        .configure(router::config)
})
.bind(format!("0.0.0.0:{}", port))?
.run()
.await
}