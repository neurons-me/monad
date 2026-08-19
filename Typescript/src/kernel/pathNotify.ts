// pathNotify.ts — in-process pub/sub for "this semantic path changed", used to
// push live 'stream' updates over the /nrp WebSocket (see http/nrpHandler.ts).
// Single-process, in-memory only — no cross-monad fan-out. Every write today
// goes through one process (see handlers/commandHandler.ts's rootCommandHandler),
// so this is sufficient for a single monad's own subscribers.

type Listener = () => void;

type Subscription = {
  namespace: string;
  path: string;
  listener: Listener;
};

const subscriptions = new Set<Subscription>();

function isPathMatch(subscribedPath: string, writtenPath: string): boolean {
  if (subscribedPath === writtenPath) return true;
  // A subscriber watching a parent path should hear about writes to any of
  // its children (e.g. watching "apps.fulltrailer.tractos.records" should
  // fire on a write to "apps.fulltrailer.tractos.records.0.status"), and a
  // subscriber watching a specific child should also hear about a write to
  // one of its ancestors (a write that replaces the whole parent object
  // implicitly changes the child's value too).
  return (
    subscribedPath.startsWith(`${writtenPath}.`) ||
    writtenPath.startsWith(`${subscribedPath}.`)
  );
}

/**
 * Register interest in a namespace+path. Returns an unsubscribe function.
 */
export function subscribe(namespace: string, path: string, listener: Listener): () => void {
  const sub: Subscription = { namespace, path, listener };
  subscriptions.add(sub);
  return () => {
    subscriptions.delete(sub);
  };
}

/**
 * Call after a write lands (namespace + the exact path that was written).
 * Fires every listener whose subscribed path matches per isPathMatch().
 */
export function notify(namespace: string, path: string): void {
  for (const sub of subscriptions) {
    if (sub.namespace !== namespace) continue;
    if (!isPathMatch(sub.path, path)) continue;
    try {
      sub.listener();
    } catch (e) {
      console.error("[pathNotify] listener threw:", e);
    }
  }
}
