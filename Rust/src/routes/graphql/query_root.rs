//monad.ai/crate/src/routes/graphql/query_root.rs
// --- Module-level comment ---
// This file defines the GraphQL QueryRoot for the Monad.AI daemon.
// It provides queries to list all available `Me` instances, fetch details of a specific `Me`,
// and get the current daemon status.
use async_graphql::{Object, SimpleObject};
use async_graphql::InputObject;
use this_me::list_us as list_identities_me;
use this_me::Me;
use std::env;

#[derive(SimpleObject)]
#[graphql(name = "Entry")]
struct GqlEntry {
    verb: String,
    key: String,
    value: String,
    timestamp: String,
}

#[derive(InputObject)]
#[graphql(name = "GetFilter")]
struct GetFilter {
    verb: String,
    key: Option<String>,
    value: Option<String>,
    context_id: Option<String>,
    limit: Option<i32>,
    offset: Option<i32>,
    since: Option<String>,
    until: Option<String>,
}

// Root of all GraphQL queries. Each method inside `impl QueryRoot`
// represents a query that clients can execute.
pub struct QueryRoot;
// Represents a simplified identity, including only its username.
#[derive(SimpleObject)]
#[graphql(name = "Identity")]
pub struct Identity {
    pub username: String,
}
// Implementation of all queries exposed in the GraphQL schema.
#[Object]
impl QueryRoot {
    // Query: Returns a list of all available `Me` instances (identities) registered locally.
    // No arguments required.
    async fn list_identities(&self) -> Vec<Identity> {
        list_identities_me()
            .unwrap_or_default()
            .into_iter()
            .map(|m| Identity {
                username: m.username,
            })
            .collect()
    }


    async fn public_info(&self, username: String) -> Option<PublicInfo> {
        match this_me::manager::load_public(&username) {
            Ok((username, public_key)) => Some(PublicInfo { username, public_key }),
            Err(_) => None,
        }
    }

    /// Returns all matching entries from a given identity (`Me`) using flexible filters.
    ///
    /// This is a general-purpose query to retrieve data stored via verbs like `be`, `have`, `at`, etc.
    /// It supports advanced filtering to narrow results based on key/value pairs, time ranges, and pagination.
    ///
    /// ### Arguments:
    /// - `username`: The username of the identity to query.
    /// - `password`: The password used to decrypt the identity's database.
    /// - `filter`: An object allowing for fine-grained query control. Includes:
    ///   - `verb`: Required. The verb table to search within (e.g. `"be"`, `"have"`, `"react"`, or `"all"`).
    ///   - `key`: Optional. Only return entries matching this key.
    ///   - `value`: Optional. Only return entries matching this value. Supports:
    ///     - `like:value` to match partial values (SQL LIKE)
    ///     - `json:key=value` to filter inside JSON values.
    ///   - `context_id`: Optional. Scopes the query to a specific context (e.g., derived from username, peer, domain).
    ///   - `limit`: Optional. Max number of results per verb. Defaults to 100.
    ///   - `offset`: Optional. Skips a number of entries for pagination.
    ///   - `since`: Optional. Only return entries after this RFC3339 timestamp.
    ///   - `until`: Optional. Only return entries before this RFC3339 timestamp.
    ///
    /// ### Returns:
    /// A list of `Entry` objects, each containing:
    /// - `verb`, `key`, `value`, `timestamp`
    ///
    /// If `verb` is `"all"`, entries from all verb tables will be returned (up to `limit` per table).
    async fn get(&self, username: String, password: String, filter: GetFilter) -> Vec<GqlEntry> {
        if let Ok(me) = Me::load(&username, &password) {
            match me.get(
                &filter.verb,
                filter.context_id.as_deref(),
                filter.key.as_deref(),
                filter.value.as_deref(),
                None,
                filter.limit.map(|v| v as usize),
                filter.offset.map(|v| v as usize),
                filter.since.as_deref(),
                filter.until.as_deref()
            ) {
                Ok(entries) => entries.into_iter().map(|(verb, key, value, timestamp)| GqlEntry { verb, key, value, timestamp }).collect(),
                Err(_) => vec![]
            }
        } else {
            vec![]
        }
    }

    // Query: Returns the current status of the daemon.
    // Currently returns mock data; should later be replaced with real daemon state.
    async fn monad_status(&self) -> MonadStatus {
        MonadStatus {
            active: true,
            port: std::env::var("PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(7777),
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}
// Represents the detailed public information of a `Me` instance,
// currently exposing only username and public key.
#[derive(SimpleObject)]
#[graphql(name = "PublicInfo")]
pub struct PublicInfo {
    pub username: String,
    pub public_key: String,
}
// Represents the daemon status, including whether it is active, its port, and the daemon version.
// This is useful for health-checking from external clients.
#[derive(SimpleObject)]
#[graphql(name = "MonadStatus")]
pub struct MonadStatus {
    pub active: bool,
    pub port: i32,
    pub version: String,
}