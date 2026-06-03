//src/routes/graphql/mod.rs
pub mod graphql;
pub mod playground;
pub mod query_root;
pub mod mutation_root;

// Re-exports for convenience:
pub use graphql::{create_schema, graphql_handler};
pub use playground::playground_handler;
pub use query_root::QueryRoot;
pub use mutation_root::MutationRoot;