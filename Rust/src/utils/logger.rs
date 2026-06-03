// src/utils/logger.rs en monad-ai
use env_logger::{Builder, Env};
#[cfg(debug_assertions)]
use std::io::Write;

pub fn init() {
    let mut builder = Builder::from_env(Env::default().default_filter_or("info"));

    #[cfg(debug_assertions)]
    {
        builder.format(|buf, record| {
            writeln!(
                buf,
                "[{} {}] {}",
                chrono::Local::now().format("%H:%M:%S"),
                record.level(),
                record.args()
            )
        });
    }

    builder.init();
}