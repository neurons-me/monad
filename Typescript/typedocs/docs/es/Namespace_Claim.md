# La Visión: El Claim del Namespace

**Estado actual:** esta visión ya está parcialmente implementada en
`monad.ai` v2.1.1. El claim del namespace sigue siendo la base de autoridad,
pero ahora el runtime también anuncia monads en `_.mesh.monads`, resuelve
claimants con `/.mesh/resolve`, y usa scoring para decidir qué monad debe
responder cuando varios pueden servir el mismo namespace.

Ver también:

- `docs/NRP/status.md`
- `docs/NRP/scoring.md`
- `docs/NRP/testing.md`

Lo que buscas es que el primer acto de tu kernel sea un **Claim**.

1. **Local Claim:** `me://local` (Yo soy este nodo).
2. **Network Claim:** `me://username.cleaker.me` (Yo soy esta identidad en el ledger).
   Al hacer esto, tu `me://` ya no es un alias genérico; se convierte en una **URL Soberana Determinista**.

----

La Visión: El Claim del Namespace
Lo que buscas es que el primer acto de tu kernel sea un **Claim**.

1. **Local Claim:** `me://local` (Yo soy este nodo).
2. **Network Claim:** `me://username.cleaker.me` (Yo soy esta identidad en el ledger).
   Al hacer esto, tu `me://` ya no es un alias genérico; se convierte en una **URL Soberana Determinista**.

----

**B primero, luego C.**

El documento que escribimos ya es bueno como visión, pero ahora que tienes el análisis real del repo encima de la mesa, necesitamos anclar cada sección a lo que existe vs. lo que falta. Si saltamos directo a reescribir el doc sin el mapa, volvemos a escribir visión en lugar de protocolo.

Vamos al mapa.
