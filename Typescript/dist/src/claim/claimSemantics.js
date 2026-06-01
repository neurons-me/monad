import { appendSemanticMemory } from "./memoryStore.js";
import { buildClaimSemanticSeeds } from "./semanticCatalog.js";
export function seedClaimNamespaceSemantics(input) {
    const timestamp = Number(input.timestamp || Date.now());
    const namespace = String(input.namespace || "").trim().toLowerCase();
    const seeds = [
        { path: "me.username", data: String(input.username || "").trim().toLowerCase() },
        { path: "me.name", data: String(input.name || "").trim() },
        { path: "me.email.primary", data: String(input.email || "").trim().toLowerCase() },
        { path: "me.phone.primary", data: String(input.phone || "").trim() },
        { path: "auth.claimed_at", data: timestamp },
        ...buildClaimSemanticSeeds({
            namespace,
            username: input.username,
            passwordHash: input.passwordHash,
        }),
    ];
    for (const seed of seeds) {
        appendSemanticMemory({
            namespace,
            path: seed.path,
            operator: seed.operator || "=",
            data: seed.data,
            timestamp,
        });
    }
    return timestamp;
}
