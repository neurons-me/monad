import fs from "fs";
import path from "path";
import crypto from "crypto";
import { normalizeNamespaceIdentity, parseNamespaceIdentityParts } from "../namespace/identity.js";
function normalizeNamespace(input) {
    return normalizeNamespaceIdentity(input);
}
function generateSelfIdentity(hostname) {
    const normalizedHostname = normalizeToken(hostname);
    if (normalizedHostname) {
        return normalizedHostname.includes(".")
            ? normalizedHostname
            : `${normalizedHostname}.local`;
    }
    return `monad-${crypto.randomBytes(4).toString("hex")}.local`;
}
function normalizeMonadProcessName(input) {
    return String(input || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function normalizePublicKey(input) {
    return String(input || "").trim().replace(/\r\n/g, "\n");
}
function deriveMonadId(publicKey) {
    const key = normalizePublicKey(publicKey);
    if (!key)
        return "";
    return `monad:${crypto.createHash("sha256").update(key).digest("hex")}`;
}
function generateCleakerKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return {
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
}
// KDF domain separation: derive a deterministic Ed25519 keypair from a compound seed.
// HKDF-SHA256(ikm=seed, salt='', info='monad.ai/ed25519/v1', length=32) → Ed25519 seed.
// Same (who, secret) compound_seed → same monad identity everywhere, every time.
function deriveEd25519KeyPairFromSeed(seed) {
    const raw = String(seed || "").trim();
    if (!raw)
        return null;
    try {
        const ikm = /^[0-9a-fA-F]{64}$/.test(raw)
            ? Buffer.from(raw, "hex")
            : Buffer.from(raw, "utf8");
        const ed25519Seed = Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("monad.ai/ed25519/v1"), 32));
        const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
        const pkcs8 = Buffer.concat([pkcs8Prefix, ed25519Seed]);
        const privateKeyObj = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
        const publicKeyObj = crypto.createPublicKey(privateKeyObj);
        return {
            publicKey: publicKeyObj.export({ type: "spki", format: "pem" }).toString(),
            privateKey: privateKeyObj.export({ type: "pkcs8", format: "pem" }).toString(),
        };
    }
    catch {
        return null;
    }
}
function publicKeyFromPrivateKey(privateKey) {
    try {
        return crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    }
    catch {
        return "";
    }
}
function defaultCleakerKeyPath(configPath) {
    return configPath.replace(/\.json$/i, ".keys.json");
}
function readCleakerKeyFile(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function ensureCleakerIdentityConfig(input) {
    const keyPath = path.resolve(path.dirname(input.configPath), String(input.env.MONAD_PRIVATE_KEY_PATH || input.fileConfig.privateKeyPath || defaultCleakerKeyPath(input.configPath)));
    const keyFile = readCleakerKeyFile(keyPath);
    let privateKey = normalizePublicKey(input.env.MONAD_PRIVATE_KEY ||
        keyFile.privateKey ||
        input.fileConfig.privateKey);
    let publicKey = normalizePublicKey(input.env.MONAD_PUBLIC_KEY || input.fileConfig.publicKey);
    if (!publicKey && privateKey) {
        publicKey = publicKeyFromPrivateKey(privateKey);
    }
    if (!publicKey || !privateKey) {
        const seedEnv = String(input.env.SEED || "").trim();
        const generated = seedEnv
            ? (deriveEd25519KeyPairFromSeed(seedEnv) ?? generateCleakerKeyPair())
            : generateCleakerKeyPair();
        publicKey = generated.publicKey;
        privateKey = generated.privateKey;
    }
    const monadId = String(input.env.MONAD_ID || input.fileConfig.monadId || deriveMonadId(publicKey)).trim();
    const { privateKey: _privateKey, ...publicConfig } = input.fileConfig;
    const next = {
        ...publicConfig,
        monadId,
        publicKey,
        privateKeyPath: path.relative(path.dirname(input.configPath), keyPath) || path.basename(keyPath),
    };
    const changed = input.fileConfig.monadId !== next.monadId ||
        input.fileConfig.publicKey !== next.publicKey ||
        input.fileConfig.privateKey !== undefined ||
        input.fileConfig.privateKeyPath !== next.privateKeyPath;
    if (changed) {
        fs.mkdirSync(path.dirname(input.configPath), { recursive: true });
        fs.writeFileSync(input.configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    }
    if (keyFile.privateKey !== privateKey || keyFile.publicKey !== publicKey) {
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, `${JSON.stringify({ publicKey, privateKey }, null, 2)}\n`, "utf8");
        try {
            fs.chmodSync(keyPath, 0o600);
        }
        catch { }
    }
    input.env.MONAD_ID = monadId;
    input.env.MONAD_PUBLIC_KEY = publicKey;
    input.env.MONAD_PRIVATE_KEY = privateKey;
    input.env.MONAD_PRIVATE_KEY_PATH = keyPath;
    return next;
}
function inferMonadProcessName(input) {
    const direct = normalizeMonadProcessName(input.env.MONAD_NAME ||
        input.env.MONAD_SURFACE ||
        input.fileConfig.monadName ||
        input.fileConfig.surface);
    if (direct)
        return direct;
    const rawTags = [
        ...(Array.isArray(input.fileConfig.tags) ? input.fileConfig.tags : []),
        ...String(input.env.MONAD_SELF_TAGS || "").split(","),
    ].map((tag) => String(tag || "").trim().toLowerCase());
    const surfaceTag = rawTags.find((tag) => tag.startsWith("surface:"));
    const fromTag = normalizeMonadProcessName(surfaceTag?.slice("surface:".length));
    if (fromTag)
        return fromTag;
    const parent = normalizeMonadProcessName(path.basename(path.dirname(input.configPath)));
    if (parent && parent !== "env" && parent !== "config" && parent !== "runtime") {
        return parent;
    }
    return undefined;
}
function ensureSelfIdentityConfig(input) {
    const explicitIdentity = normalizeNamespace(input.env.MONAD_SELF_IDENTITY || input.fileConfig.identity);
    const monadName = inferMonadProcessName(input);
    if (monadName)
        input.env.MONAD_NAME = monadName;
    if (explicitIdentity) {
        const config = monadName && !input.fileConfig.monadName
            ? { ...input.fileConfig, monadName }
            : input.fileConfig;
        return ensureCleakerIdentityConfig({
            configPath: input.configPath,
            env: input.env,
            fileConfig: config,
        });
    }
    const normalizedHostname = normalizeToken(input.hostname);
    const defaultEndpointHost = normalizedHostname
        ? normalizedHostname.includes(".")
            ? normalizedHostname
            : `${normalizedHostname}.local`
        : "localhost";
    const generated = {
        ...input.fileConfig,
        identity: generateSelfIdentity(input.hostname),
        monadName,
        endpoint: String(input.env.MONAD_SELF_ENDPOINT || input.fileConfig.endpoint || `http://${defaultEndpointHost}:${input.port}`).trim(),
        hostname: String(input.fileConfig.hostname || input.hostname || "").trim() || String(input.hostname || ""),
        tags: Array.isArray(input.fileConfig.tags) && input.fileConfig.tags.length > 0
            ? input.fileConfig.tags
            : ["local", "primary"],
        type: input.fileConfig.type || "desktop",
        trust: input.fileConfig.trust || "owner",
    };
    fs.mkdirSync(path.dirname(input.configPath), { recursive: true });
    fs.writeFileSync(input.configPath, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
    input.env.MONAD_SELF_IDENTITY = String(generated.identity || "");
    input.env.MONAD_SELF_ENDPOINT = String(generated.endpoint || "");
    if (monadName)
        input.env.MONAD_NAME = monadName;
    return ensureCleakerIdentityConfig({
        configPath: input.configPath,
        env: input.env,
        fileConfig: generated,
    });
}
function normalizeToken(input) {
    return String(input || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "");
}
function uniq(values) {
    return Array.from(new Set(values.filter(Boolean)));
}
function splitValues(input) {
    return uniq(String(input || "").split(",").map((value) => normalizeToken(value)));
}
function toArray(input) {
    if (Array.isArray(input)) {
        return uniq(input.map((value) => normalizeToken(value)));
    }
    if (typeof input === "string") {
        return splitValues(input);
    }
    return [];
}
function extractEndpointHost(endpoint) {
    const raw = String(endpoint || "").trim();
    if (!raw)
        return "";
    try {
        return normalizeToken(new URL(raw).hostname);
    }
    catch {
        return normalizeToken(raw.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0]);
    }
}
function extractEndpointParts(endpoint) {
    const raw = String(endpoint || "").trim();
    if (!raw) {
        return {
            protocol: "http:",
            hostname: "",
            port: "",
            normalized: "",
        };
    }
    try {
        const parsed = new URL(raw);
        return {
            protocol: parsed.protocol || "http:",
            hostname: normalizeToken(parsed.hostname),
            port: String(parsed.port || "").trim(),
            normalized: parsed.toString().replace(/\/+$/, ""),
        };
    }
    catch {
        const noProto = raw.replace(/^https?:\/\//i, "");
        const hostPart = noProto.split("/")[0] || "";
        const hostname = normalizeToken(hostPart.split(":")[0] || "");
        const port = String(hostPart.split(":")[1] || "").trim();
        return {
            protocol: /^https:\/\//i.test(raw) ? "https:" : "http:",
            hostname,
            port,
            normalized: raw.replace(/\/+$/, ""),
        };
    }
}
function isLoopbackishHost(host) {
    const normalized = normalizeToken(host);
    return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/.test(normalized);
}
function isLikelyLocalHost(host) {
    const normalized = normalizeToken(host);
    return Boolean(normalized) && (isLoopbackishHost(normalized) || normalized.endsWith(".local"));
}
function normalizeSurfaceType(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "desktop" ||
        value === "mobile" ||
        value === "server" ||
        value === "browser-tab" ||
        value === "node") {
        return value;
    }
    return null;
}
function normalizeSurfaceTrust(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "owner" || value === "trusted-peer" || value === "guest") {
        return value;
    }
    return null;
}
function inferSurfaceType(host) {
    const normalized = normalizeToken(host);
    if (!normalized)
        return "node";
    if (/(iphone|ipad|android|pixel|mobile)/.test(normalized))
        return "mobile";
    if (/(tab|browser)/.test(normalized))
        return "browser-tab";
    if (/(macbook|imac|desktop|laptop|notebook|pc|workstation|\.local$)/.test(normalized)) {
        return "desktop";
    }
    if (isLoopbackishHost(normalized))
        return "desktop";
    return "server";
}
function inferSurfaceTrust(host, endpointHost) {
    return isLikelyLocalHost(host) || isLikelyLocalHost(endpointHost) ? "owner" : "trusted-peer";
}
function toNumberOrNull(input) {
    if (typeof input === "number" && Number.isFinite(input))
        return input;
    if (typeof input === "string" && input.trim()) {
        const parsed = Number(input);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function normalizeSurfaceCapacity(input) {
    const raw = input && typeof input === "object" ? input : {};
    return {
        cpuCores: toNumberOrNull(raw.cpuCores),
        ramGb: toNumberOrNull(raw.ramGb),
        storageGb: toNumberOrNull(raw.storageGb),
        bandwidthMbps: toNumberOrNull(raw.bandwidthMbps),
    };
}
function inferResources(type, host, endpointHost, configured) {
    const resources = new Set(configured.map((value) => normalizeToken(value)).filter(Boolean));
    resources.add("public_ingress");
    resources.add("keychain");
    if (type === "desktop") {
        resources.add("filesystem");
        resources.add("gpu");
        resources.add("camera");
    }
    else if (type === "mobile") {
        resources.add("camera");
    }
    else if (type === "server") {
        resources.add("filesystem");
    }
    if (isLikelyLocalHost(host) || isLikelyLocalHost(endpointHost)) {
        resources.add("local_lan");
    }
    return Array.from(resources);
}
function resolveSurfaceRootName(identity, fallbackHost) {
    const parsed = parseNamespaceIdentityParts(identity);
    const host = normalizeToken(parsed.host);
    if (host && host !== "unknown")
        return host;
    return normalizeToken(fallbackHost);
}
function buildCleakerProof(input) {
    if (!input.id || !input.publicKey || !input.privateKey)
        return undefined;
    const message = JSON.stringify({
        protocol: "cleaker(monad)",
        version: 1,
        subject: "monad",
        id: input.id,
        name: input.name || null,
        namespace: input.namespace,
        endpoint: input.endpoint,
        issuedAt: input.now,
    });
    try {
        const signature = crypto.sign(null, Buffer.from(message), input.privateKey).toString("base64url");
        return {
            protocol: "cleaker(monad)",
            version: 1,
            subject: "monad",
            id: input.id,
            publicKey: {
                type: "spki",
                format: "pem",
                key: input.publicKey,
            },
            signature: {
                algorithm: "ed25519",
                message,
                value: signature,
                issuedAt: input.now,
            },
        };
    }
    catch {
        return undefined;
    }
}
export function buildSelfSurfaceEntry(input) {
    const now = typeof input.now === "number" ? input.now : Date.now();
    const originParts = extractEndpointParts(input.origin);
    const endpointParts = extractEndpointParts(input.self?.endpoint || input.origin);
    const fallbackHostId = normalizeToken(input.self?.hostname) || normalizeToken(input.fallbackHost);
    const hostId = fallbackHostId && isLoopbackishHost(endpointParts.hostname || originParts.hostname)
        ? fallbackHostId
        : normalizeToken(input.self?.hostname) ||
            endpointParts.hostname ||
            originParts.hostname ||
            fallbackHostId ||
            "unknown-host";
    const endpointHost = endpointParts.hostname || originParts.hostname || hostId;
    const namespaceHost = isLoopbackishHost(endpointHost) && hostId
        ? hostId
        : endpointHost || hostId;
    const protocol = endpointParts.protocol || originParts.protocol || "http:";
    const port = endpointParts.port || originParts.port;
    const namespace = `${protocol}//${namespaceHost}${port ? `:${port}` : ""}`;
    const endpoint = endpointParts.normalized || originParts.normalized || input.origin.trim();
    const type = normalizeSurfaceType(input.self?.type) || inferSurfaceType(hostId);
    const trust = normalizeSurfaceTrust(input.self?.trust) || inferSurfaceTrust(hostId, endpointHost);
    const rootName = resolveSurfaceRootName(input.self?.identity || input.requestNamespace, namespaceHost || hostId);
    const monadName = input.self?.monadName || process.env.MONAD_NAME || process.env.MONAD_SURFACE || undefined;
    const publicKey = input.self?.publicKey || process.env.MONAD_PUBLIC_KEY || undefined;
    const privateKey = input.self?.privateKey || process.env.MONAD_PRIVATE_KEY || undefined;
    const monadId = input.self?.monadId || process.env.MONAD_ID || deriveMonadId(publicKey);
    const cleaker = buildCleakerProof({
        id: monadId,
        name: monadName,
        publicKey,
        privateKey,
        namespace,
        endpoint,
        now,
    });
    return {
        monad: {
            id: monadId,
            name: monadName,
            publicKey,
        },
        monadId,
        monadName,
        cleaker,
        hostId,
        type,
        trust,
        resources: inferResources(type, hostId, endpointHost, input.self?.resources || []),
        capacity: normalizeSurfaceCapacity(input.self?.capacity),
        status: {
            availability: "online",
            latencyMs: null,
            syncState: "current",
            lastSeen: now,
        },
        namespace,
        endpoint,
        rootName,
    };
}
export function parseSelectorGroups(selectorRaw) {
    const raw = String(selectorRaw || "").trim();
    if (!raw)
        return [];
    return raw
        .split("|")
        .map((group) => group.trim())
        .filter(Boolean)
        .map((group) => group
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
        const colon = part.indexOf(":");
        if (colon < 0) {
            return {
                type: "tag",
                values: splitValues(part),
            };
        }
        return {
            type: normalizeToken(part.slice(0, colon)),
            values: splitValues(part.slice(colon + 1)),
        };
    })
        .filter((clause) => clause.type && clause.values.length > 0))
        .filter((group) => group.length > 0);
}
function matchClause(clause, tagSet, hostSet) {
    if (clause.type === "device" || clause.type === "tag") {
        return clause.values.filter((value) => tagSet.has(value));
    }
    if (clause.type === "host") {
        return clause.values.filter((value) => hostSet.has(value) || tagSet.has(value));
    }
    return [];
}
export function loadSelfNodeConfig(input) {
    const configPath = path.resolve(input.cwd, String(input.env.MONAD_SELF_CONFIG_PATH || "env/self.json"));
    let fileConfig = {};
    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                fileConfig = parsed;
            }
        }
        catch {
            fileConfig = {};
        }
    }
    fileConfig = ensureSelfIdentityConfig({
        configPath,
        env: input.env,
        hostname: input.hostname,
        port: input.port,
        fileConfig,
    });
    const identity = normalizeNamespace(input.env.MONAD_SELF_IDENTITY || fileConfig.identity);
    if (!identity)
        return null;
    const monadName = inferMonadProcessName({ env: input.env, fileConfig, configPath });
    if (monadName)
        input.env.MONAD_NAME = monadName;
    const normalizedHostname = normalizeToken(input.hostname);
    const defaultEndpointHost = normalizedHostname
        ? normalizedHostname.includes(".")
            ? normalizedHostname
            : `${normalizedHostname}.local`
        : "localhost";
    const endpoint = String(input.env.MONAD_SELF_ENDPOINT || fileConfig.endpoint || `http://${defaultEndpointHost}:${input.port}`).trim();
    const hostname = String(fileConfig.hostname || input.hostname || "").trim() || String(input.hostname || "");
    const tags = uniq([
        ...toArray(fileConfig.tags),
        ...toArray(input.env.MONAD_SELF_TAGS),
        normalizeToken(hostname),
        extractEndpointHost(endpoint),
    ]);
    const type = normalizeSurfaceType(input.env.MONAD_SELF_TYPE) ||
        normalizeSurfaceType(fileConfig.type);
    const trust = normalizeSurfaceTrust(input.env.MONAD_SELF_TRUST) ||
        normalizeSurfaceTrust(fileConfig.trust);
    const resources = uniq([
        ...toArray(fileConfig.resources),
        ...toArray(input.env.MONAD_SELF_RESOURCES),
    ]);
    const capacity = normalizeSurfaceCapacity(fileConfig.capacity);
    input.env.MONAD_SELF_IDENTITY = identity;
    input.env.MONAD_SELF_ENDPOINT = endpoint;
    input.env.MONAD_SELF_HOSTNAME = hostname;
    input.env.MONAD_SELF_TAGS = tags.join(",");
    return {
        identity,
        monadId: String(input.env.MONAD_ID || fileConfig.monadId || deriveMonadId(fileConfig.publicKey)).trim() || undefined,
        monadName,
        publicKey: normalizePublicKey(input.env.MONAD_PUBLIC_KEY || fileConfig.publicKey) || undefined,
        privateKey: normalizePublicKey(input.env.MONAD_PRIVATE_KEY || fileConfig.privateKey) || undefined,
        tags,
        endpoint,
        hostname,
        configPath,
        type: type || undefined,
        trust: trust || undefined,
        resources,
        capacity,
    };
}
export function resolveSelfDispatch(baseInput, selectorRawInput, self) {
    const base = normalizeNamespace(baseInput);
    const selectorRaw = String(selectorRawInput || "").trim() || null;
    if (!self) {
        return {
            mode: "unconfigured",
            configured: false,
            identity: null,
            base,
            selectorRaw,
            hasInstanceSelector: false,
            matched: [],
            required: [],
            endpoint: null,
            tags: [],
            reason: "Self-mapping is not configured on this node.",
        };
    }
    const groups = parseSelectorGroups(selectorRaw);
    const instanceGroups = groups
        .map((group) => group.filter((clause) => clause.type === "device" || clause.type === "host" || clause.type === "tag"))
        .filter((group) => group.length > 0);
    const required = uniq(instanceGroups.flatMap((group) => group.flatMap((clause) => clause.values)));
    if (base !== self.identity) {
        return {
            mode: "foreign",
            configured: true,
            identity: self.identity,
            base,
            selectorRaw,
            hasInstanceSelector: required.length > 0,
            matched: [],
            required,
            endpoint: self.endpoint,
            tags: self.tags,
            reason: "The requested namespace does not belong to this node identity.",
        };
    }
    if (!selectorRaw) {
        return {
            mode: "local",
            configured: true,
            identity: self.identity,
            base,
            selectorRaw,
            hasInstanceSelector: false,
            matched: ["identity"],
            required: [],
            endpoint: self.endpoint,
            tags: self.tags,
            reason: "Base identity matches this node.",
        };
    }
    if (required.length === 0) {
        return {
            mode: "unscoped",
            configured: true,
            identity: self.identity,
            base,
            selectorRaw,
            hasInstanceSelector: false,
            matched: [],
            required: [],
            endpoint: self.endpoint,
            tags: self.tags,
            reason: "Selector exists, but it does not constrain an instance tag or host.",
        };
    }
    const tagSet = new Set(self.tags.map((tag) => normalizeToken(tag)).filter(Boolean));
    const hostSet = new Set([
        normalizeToken(self.hostname),
        extractEndpointHost(self.endpoint),
    ].filter(Boolean));
    for (const group of instanceGroups) {
        const matched = uniq(group.flatMap((clause) => matchClause(clause, tagSet, hostSet)));
        const satisfied = group.every((clause) => matchClause(clause, tagSet, hostSet).length > 0);
        if (!satisfied)
            continue;
        return {
            mode: "local",
            configured: true,
            identity: self.identity,
            base,
            selectorRaw,
            hasInstanceSelector: true,
            matched,
            required: uniq(group.flatMap((clause) => clause.values)),
            endpoint: self.endpoint,
            tags: self.tags,
            reason: "Selector matches this node identity and tags.",
        };
    }
    return {
        mode: "remote",
        configured: true,
        identity: self.identity,
        base,
        selectorRaw,
        hasInstanceSelector: true,
        matched: [],
        required,
        endpoint: self.endpoint,
        tags: self.tags,
        reason: "Selector targets the same identity, but a different instance surface.",
    };
}
