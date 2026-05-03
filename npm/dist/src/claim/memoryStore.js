import crypto from "crypto";
import { normalizeNamespaceRootName } from "../namespace/identity.js";
import { getKernel, kernelPathFor, namespaceToKernelPrefix, getRootNamespace } from "../kernel/manager.js";
export function isSystemSemanticPath(pathInput) {
    const path = String(pathInput || "").trim().toLowerCase();
    return path.startsWith("schema.") || path.startsWith("gui.");
}
const _nonces = new Map();
export function createSessionNonce(usernameInput, ttlMs = 120000) {
    const username = usernameInput.trim().toLowerCase();
    const iat = Date.now();
    const exp = iat + Math.max(1000, ttlMs);
    const nonce = crypto.randomBytes(24).toString("base64url");
    _nonces.set(username, { nonce, iat, exp });
    return { username, nonce, iat, exp };
}
export function consumeSessionNonce(usernameInput, nonceInput) {
    const username = usernameInput.trim().toLowerCase();
    const nonce = nonceInput.trim();
    if (!username || !nonce)
        return false;
    const record = _nonces.get(username);
    if (!record)
        return false;
    const valid = record.nonce === nonce && record.exp >= Date.now();
    if (valid)
        _nonces.delete(username);
    return valid;
}
// ─── helpers ─────────────────────────────────────────────────────────────────
function kernelWrite(namespace, path, data, operator) {
    const kernel = getKernel();
    const kpath = kernelPathFor(namespace, path);
    if (operator === "-") {
        kernel.execute(`me://self:write/${kpath.split(".").join("/")}`, undefined);
        return;
    }
    if (operator === "=" && typeof data !== "object") {
        // preserve explicit = operator via proxy eval syntax (primitives only — arrays/objects corrupt via eval)
        const parts = kpath.split(".");
        const leafName = parts[parts.length - 1];
        const scopeParts = parts.slice(0, -1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scope = scopeParts.reduce((p, k) => p[k], kernel);
        scope["="](leafName, data);
        return;
    }
    kernel.execute(`me://self:write/${kpath.split(".").join("/")}`, data);
}
function kernelRead(namespace, path) {
    const kpath = kernelPathFor(namespace, path);
    const mems = allMemories();
    for (let i = mems.length - 1; i >= 0; i--) {
        const m = mems[i];
        if (m.path === kpath) {
            return m.operator === "-" ? undefined : m.value;
        }
    }
    return undefined;
}
function memoryToRow(mem, index) {
    const kpath = mem.path;
    let namespace = getRootNamespace();
    let path = kpath;
    if (kpath.startsWith("users.")) {
        const rest = kpath.slice("users.".length);
        const dot = rest.indexOf(".");
        if (dot !== -1) {
            const username = rest.slice(0, dot);
            path = rest.slice(dot + 1);
            namespace = `${username}.${getRootNamespace()}`;
        }
    }
    return {
        id: index,
        namespace,
        path,
        operator: mem.operator,
        data: mem.value,
        hash: mem.hash,
        prevHash: mem.prevHash ?? "",
        signature: null,
        timestamp: mem.timestamp,
    };
}
function allMemories() {
    return getKernel().memories;
}
function memoriesForPrefix(prefix) {
    if (!prefix) {
        // root namespace: exclude user sub-paths (users.X.*)
        return allMemories().filter((m) => {
            if (!m.path.startsWith("users."))
                return true;
            const afterUsers = m.path.slice("users.".length);
            return !afterUsers.includes("."); // pointer level only (users.alice), not (users.alice.profile)
        });
    }
    // Normalize: strip trailing dot so we always check startsWith(p + ".")
    const p = prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
    // For user-namespace prefix (users.X): exclude the pointer itself, only include sub-paths
    const isUserPrefix = /^users\.[^.]+$/.test(p);
    if (isUserPrefix) {
        return allMemories().filter((m) => m.path.startsWith(`${p}.`));
    }
    return allMemories().filter((m) => m.path === p || m.path.startsWith(`${p}.`));
}
// ─── core memory API ─────────────────────────────────────────────────────────
export function appendSemanticMemory(input) {
    const namespace = input.namespace.trim().toLowerCase();
    const path = input.path.trim();
    if (!namespace || !path)
        throw new Error("INVALID_MEMORY_INPUT");
    kernelWrite(namespace, path, input.data, input.operator);
    const mems = allMemories();
    const last = mems[mems.length - 1];
    if (!last)
        throw new Error("MEMORY_WRITE_FAILED");
    return memoryToRow(last, mems.length - 1);
}
export function listSemanticMemoriesByNamespace(namespaceInput, options = {}) {
    const namespace = namespaceInput.trim().toLowerCase();
    if (!namespace)
        return [];
    const prefix = namespaceToKernelPrefix(namespace);
    const pathFilter = options.prefix ? `${prefix ? prefix + "." : ""}${options.prefix}` : prefix;
    const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
    const mems = memoriesForPrefix(pathFilter);
    return mems.slice(-limit).map((m, i) => memoryToRow(m, i));
}
export function listSemanticMemoriesByNamespaceBranch(namespaceInput, branchPathInput, options = {}) {
    const namespace = namespaceInput.trim().toLowerCase();
    if (!namespace)
        return [];
    const branchPath = branchPathInput.split(".").filter(Boolean).join(".");
    if (!branchPath)
        return listSemanticMemoriesByNamespace(namespace, options);
    const prefix = namespaceToKernelPrefix(namespace);
    const fullBranch = prefix ? `${prefix}.${branchPath}` : branchPath;
    const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
    const mems = memoriesForPrefix(fullBranch);
    return mems.slice(-limit).map((m, i) => memoryToRow(m, i));
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function setDeepValue(target, pathInput, value) {
    const parts = pathInput.split(".").filter(Boolean);
    if (!parts.length)
        return;
    let cursor = target;
    for (let i = 0; i < parts.length; i++) {
        const key = parts[i];
        if (i === parts.length - 1) {
            cursor[key] = value;
            return;
        }
        if (!isPlainObject(cursor[key]))
            cursor[key] = {};
        cursor = cursor[key];
    }
}
function deleteDeepValue(target, pathInput) {
    const parts = pathInput.split(".").filter(Boolean);
    if (!parts.length)
        return;
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!isPlainObject(cursor[key]))
            return;
        cursor = cursor[key];
    }
    delete cursor[parts[parts.length - 1]];
}
export function buildSemanticTreeForNamespace(namespaceInput, options = {}) {
    const memories = listSemanticMemoriesByNamespace(namespaceInput, { ...options, limit: options.limit ?? 10000 });
    const tree = {};
    for (const mem of memories) {
        if (mem.operator === "-") {
            deleteDeepValue(tree, mem.path);
            continue;
        }
        setDeepValue(tree, mem.path, mem.data);
    }
    return tree;
}
export function buildSemanticBranchTreeForNamespace(namespaceInput, branchPathInput, options = {}) {
    const memories = listSemanticMemoriesByNamespaceBranch(namespaceInput, branchPathInput, { limit: options.limit ?? 10000 });
    const tree = {};
    for (const mem of memories) {
        if (mem.operator === "-") {
            deleteDeepValue(tree, mem.path);
            continue;
        }
        setDeepValue(tree, mem.path, mem.data);
    }
    return tree;
}
function getDeepValue(target, pathInput) {
    const parts = pathInput.split(".").filter(Boolean);
    let cursor = target;
    for (const part of parts) {
        if (!isPlainObject(cursor))
            return undefined;
        cursor = cursor[part];
    }
    return cursor;
}
export function readSemanticBranchForNamespace(namespaceInput, pathInput) {
    const path = pathInput.split(".").filter(Boolean).join(".");
    if (!path)
        return buildSemanticTreeForNamespace(namespaceInput);
    const tree = buildSemanticBranchTreeForNamespace(namespaceInput, path);
    return getDeepValue(tree, path);
}
export function readSemanticValueForNamespace(namespaceInput, pathInput) {
    return kernelRead(namespaceInput, pathInput);
}
export function listSemanticMemoriesByRootNamespace(rootNamespaceInput, options = {}) {
    const rootNamespace = normalizeNamespaceRootName(rootNamespaceInput);
    if (!rootNamespace)
        return [];
    const limit = Math.max(1, Math.min(5000, options.limit ?? 500));
    const mems = allMemories();
    return mems
        .map((m, i) => memoryToRow(m, i))
        .filter((row) => normalizeNamespaceRootName(row.namespace) === rootNamespace)
        .filter((row) => options.includeSystem || !isSystemSemanticPath(row.path))
        .slice(0, limit);
}
// ─── authorized hosts (kernel-backed projection) ─────────────────────────────
function normalizeHostKey(input) {
    return input.trim().toLowerCase()
        .replace(/\.local$/i, "")
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function hostKernelPrefix(namespace, hostKey) {
    const prefix = namespaceToKernelPrefix(namespace);
    return prefix ? `${prefix}.host.${hostKey}` : `host.${hostKey}`;
}
export function listHostsByNamespace(namespaceInput, usernameInput) {
    const namespace = namespaceInput.trim().toLowerCase();
    const username = usernameInput.trim().toLowerCase();
    if (!username)
        return [];
    const targetNs = namespace || `${username}.${getRootNamespace()}`;
    const prefix = namespaceToKernelPrefix(targetNs);
    const hostsPrefix = prefix ? `${prefix}.host` : "host";
    const mems = memoriesForPrefix(hostsPrefix);
    const hostMap = new Map();
    for (const mem of mems) {
        const rel = mem.path.slice(hostsPrefix.length + 1); // e.g. "macbook.status"
        const dot = rel.indexOf(".");
        if (dot === -1)
            continue;
        const hkey = rel.slice(0, dot);
        const field = rel.slice(dot + 1);
        if (!hostMap.has(hkey)) {
            hostMap.set(hkey, {
                id: crypto.randomUUID(),
                namespace: targetNs,
                username,
                host_key: hkey,
                fingerprint: "",
                public_key: "",
                hostname: "",
                label: hkey,
                local_endpoint: "localhost:8161",
                attestation: "",
                capabilities_json: "[]",
                status: "authorized",
                created_at: mem.timestamp,
                last_used: mem.timestamp,
                revoked_at: null,
            });
        }
        const row = hostMap.get(hkey);
        const val = mem.value;
        switch (field) {
            case "fingerprint":
                row.fingerprint = String(val ?? "");
                break;
            case "public_key":
                row.public_key = String(val ?? "");
                break;
            case "hostname":
                row.hostname = String(val ?? "");
                break;
            case "label":
                row.label = String(val ?? "");
                break;
            case "local_endpoint":
                row.local_endpoint = String(val ?? "");
                break;
            case "attestation":
                row.attestation = String(val ?? "");
                break;
            case "capabilities":
                row.capabilities_json = JSON.stringify(Array.isArray(val) ? val : []);
                break;
            case "status":
                row.status = String(val ?? "").toLowerCase() === "revoked" ? "revoked" : "authorized";
                if (row.status === "revoked")
                    row.revoked_at = mem.timestamp;
                break;
            case "last_used":
                row.last_used = Number(val ?? mem.timestamp);
                break;
        }
        if (mem.timestamp > row.last_used)
            row.last_used = mem.timestamp;
    }
    return [...hostMap.values()].sort((a, b) => b.last_used - a.last_used);
}
export function listHostsByUsername(usernameInput) {
    return listHostsByNamespace("", usernameInput);
}
export function getHostStatus(namespaceInput, usernameInput, fingerprintInput) {
    const hosts = listHostsByNamespace(namespaceInput, usernameInput);
    const host = hosts.find((h) => h.fingerprint === fingerprintInput.trim());
    return host?.status ?? null;
}
export function listHostMemoryHistory(namespaceInput, usernameInput, fingerprintInput, limitInput = 200) {
    const namespace = namespaceInput.trim().toLowerCase();
    const username = usernameInput.trim().toLowerCase();
    const fingerprint = fingerprintInput.trim();
    if (!namespace || !username || !fingerprint)
        return [];
    const hosts = listHostsByNamespace(namespace, username);
    const host = hosts.find((h) => h.fingerprint === fingerprint);
    const hostKey = host ? host.host_key : normalizeHostKey(fingerprint);
    const prefix = hostKernelPrefix(namespace, hostKey);
    const limit = Math.max(1, Math.min(2000, limitInput));
    const mems = memoriesForPrefix(prefix).slice(-limit);
    return mems.map((m, i) => ({
        ...memoryToRow(m, i),
        namespace,
        username,
        fingerprint,
        host_key: hostKey,
    }));
}
export function rebuildAuthorizedHostsProjection(_usernameInput) {
    // no-op: kernel memories are the source of truth, no separate projection needed
    return 0;
}
