use actix::{Actor, StreamHandler};
use actix::prelude::*;
use actix_web::{web, Error, HttpRequest, HttpResponse};
use actix_web_actors::ws;

pub struct MeWs;

impl MeWs {
    pub fn new() -> Self {
        MeWs {}
    }
}

impl Actor for MeWs {
    type Context = ws::WebsocketContext<Self>;
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for MeWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(ping)) => ctx.pong(&ping),
            Ok(ws::Message::Text(text)) => {
                // Aquí manejas mensajes entrantes
                println!("Received: {}", text);
                // ctx.text(format!("Echo: {}", text));
                ctx.text(r#"{"type":"status","active":true}"#);
            }
            Ok(ws::Message::Close(reason)) => {
                println!("Connection closed: {:?}", reason);
                ctx.stop();
            }
            _ => (),
        }
    }
}

pub async fn me_ws_handler(req: HttpRequest, stream: web::Payload) -> Result<HttpResponse, Error> {
    ws::start(MeWs::new(), &req, stream)
}