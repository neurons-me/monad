//src/routes/graphql/graphql.rs
use std::sync::Arc;
use actix_web::web;
use async_graphql::{Schema, EmptySubscription};
use async_graphql_actix_web::{GraphQLRequest, GraphQLResponse};
use crate::routes::graphql::{QueryRoot, MutationRoot};

pub fn create_schema() -> Arc<Schema<QueryRoot, MutationRoot, EmptySubscription>> {
    Arc::new(
        Schema::build(QueryRoot, MutationRoot, EmptySubscription)
            .finish()
    )
}

pub async fn graphql_handler(
    schema: web::Data<Arc<Schema<QueryRoot, MutationRoot, EmptySubscription>>>,
    req: GraphQLRequest,
) -> GraphQLResponse {
    schema.execute(req.into_inner()).await.into()
}