use async_graphql::{Context, Object};
use this_me::Me;
use this_me::utils::me_error::MeError;

pub struct MutationRoot;

struct MeMutator {
    inner: Me,
}

impl MeMutator {
    fn new(username: &str, hash: &str) -> Option<Self> {
        if let Ok(me) = Me::load(username, hash) {
            Some(Self { inner: me })
        } else {
            None
        }
    }

    fn be(&mut self, key: &str, value: &str, context_id: Option<&str>) -> Result<(), MeError> {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.as_deref().unwrap_or_else(|| {
            println!("⚠️  No context_id provided; using default context: '{}'", default_context);
            &default_context
        });
        println!("🧪 MeMutator.be(): context_id='{}', key='{}', value='{}'", ctx, key, value);
        self.inner.be(ctx, key, value)
    }

    fn have(&mut self, key: &str, value: &str, context_id: Option<&str>) -> bool {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.unwrap_or(&default_context);
        self.inner.have(ctx, key, value).is_ok()
    }

    fn do_(&mut self, key: &str, value: &str, context_id: Option<&str>) -> bool {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.unwrap_or(&default_context);
        self.inner.do_(ctx, key, value).is_ok()
    }

    fn at(&mut self, key: &str, value: &str, context_id: Option<&str>) -> bool {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.unwrap_or(&default_context);
        self.inner.at(ctx, key, value).is_ok()
    }

    fn relate(&mut self, key: &str, value: &str, context_id: Option<&str>) -> bool {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.unwrap_or(&default_context);
        self.inner.relate(ctx, key, value).is_ok()
    }

    fn react(&mut self, key: &str, value: &str, context_id: Option<&str>) -> bool {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.unwrap_or(&default_context);
        self.inner.react(ctx, key, value).is_ok()
    }

    fn communicate(&mut self, key: &str, value: &str, context_id: Option<&str>) -> bool {
        let default_context = self.inner.context_id.clone();
        let ctx = context_id.unwrap_or(&default_context);
        self.inner.communicate(ctx, key, value).is_ok()
    }
}

#[Object]
impl MutationRoot {
    async fn be(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        println!("🔁 GraphQL be() called with: username='{}', key='{}', value='{}'", username, key, value);
        match MeMutator::new(&username, &password) {
            Some(mut me) => {
                let result = me.be(&key, &value, context_id.as_deref());
                if let Err(err) = &result {
                    println!("❌ GraphQL BE error: {}", err);
                    println!("❌ Error from MeMutator.be(): {:?}", err);
                }
                result.is_ok()
            },
            None => {
                println!("❌ GraphQL BE error: Failed to initialize identity '{}'", username);
                false
            }
        }
    }

    async fn have(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        MeMutator::new(&username, &password).map(|mut me| me.have(&key, &value, context_id.as_deref())).unwrap_or(false)
    }

    async fn do_(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        MeMutator::new(&username, &password).map(|mut me| me.do_(&key, &value, context_id.as_deref())).unwrap_or(false)
    }

    async fn at(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        MeMutator::new(&username, &password).map(|mut me| me.at(&key, &value, context_id.as_deref())).unwrap_or(false)
    }

    async fn relate(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        MeMutator::new(&username, &password).map(|mut me| me.relate(&key, &value, context_id.as_deref())).unwrap_or(false)
    }

    async fn react(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        MeMutator::new(&username, &password).map(|mut me| me.react(&key, &value, context_id.as_deref())).unwrap_or(false)
    }

    async fn communicate(&self, _ctx: &Context<'_>, username: String, password: String, key: String, value: String, context_id: Option<String>) -> bool {
        MeMutator::new(&username, &password).map(|mut me| me.communicate(&key, &value, context_id.as_deref())).unwrap_or(false)
    }
}