# NetGet Registration

`monad.ai` treats NetGet as the local gateway and registry. When a monad starts, it reports itself to `local.netget` through `POST /apps/report` and keeps that entry fresh with a heartbeat.

The registration is intentionally internal-first:

- `kind: "monad"` marks the app as a monad citizen of NetGet.
- `host` defaults to `127.0.0.1`; monads should not expose LAN/WAN ports directly.
- `metadata.monadName`, `metadata.monadId`, `metadata.namespace`, and `metadata.capabilities` make the entry usable by GUI discovery.
- `exposure.visibility` defaults to `loopback`.
- lifecycle support is advertised, but NetGet policy decides which controls are actually allowed.

The focused build guard is:

```bash
npm run test:netget
```

`npm run build` runs that guard through `prebuild`.
