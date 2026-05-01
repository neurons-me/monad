import os from "os";
import path from "path";
import { rebuildProjectedNamespaceClaims } from "./claim/records.js";
import { ensureRootSemanticBootstrap } from "./claim/semanticBootstrap.js";
import { getKernel, getKernelStateDir } from "./kernel/manager.js";
import { normalizeNamespaceIdentity, normalizeNamespaceRootName } from "./namespace/identity.js";
import { loadSelfNodeConfig } from "./http/selfMapping.js";
function stringifyList(input) {
    if (Array.isArray(input))
        return input.join(",");
    return input;
}
function resolvePath(cwd, value, fallback) {
    return path.resolve(cwd, value || fallback);
}
function writeEnv(env, key, value) {
    if (value === undefined || value === null || value === "")
        return;
    env[key] = String(value);
    process.env[key] = String(value);
}
function resolveEnvValue(options, env, key, envKey) {
    const raw = options[key];
    if (Array.isArray(raw))
        return raw.join(",");
    if (raw !== undefined && raw !== null && raw !== "")
        return String(raw);
    return env[envKey];
}
export function resolveMonadRuntimeConfig(options = {}) {
    const sourceEnv = options.env || process.env;
    const env = process.env;
    const cwd = path.resolve(options.cwd || process.cwd());
    const port = options.port || sourceEnv.PORT || 8161;
    const nodeHostname = options.hostname || sourceEnv.MONAD_SELF_HOSTNAME || os.hostname();
    const fetchProxyTimeoutMs = Number(options.fetchProxyTimeoutMs || sourceEnv.MONAD_FETCH_TIMEOUT_MS || 15000);
    writeEnv(env, "PORT", port);
    writeEnv(env, "ME_SEED", resolveEnvValue(options, sourceEnv, "seed", "ME_SEED"));
    writeEnv(env, "ME_NAMESPACE", resolveEnvValue(options, sourceEnv, "namespace", "ME_NAMESPACE"));
    writeEnv(env, "ME_STATE_DIR", resolveEnvValue(options, sourceEnv, "stateDir", "ME_STATE_DIR"));
    writeEnv(env, "MONAD_CLAIM_DIR", resolveEnvValue(options, sourceEnv, "claimDir", "MONAD_CLAIM_DIR"));
    writeEnv(env, "MONAD_SELF_CONFIG_PATH", resolveEnvValue(options, sourceEnv, "selfConfigPath", "MONAD_SELF_CONFIG_PATH"));
    writeEnv(env, "MONAD_SELF_IDENTITY", resolveEnvValue(options, sourceEnv, "selfIdentity", "MONAD_SELF_IDENTITY"));
    writeEnv(env, "MONAD_SELF_HOSTNAME", resolveEnvValue(options, sourceEnv, "selfHostname", "MONAD_SELF_HOSTNAME") || nodeHostname);
    writeEnv(env, "MONAD_SELF_ENDPOINT", resolveEnvValue(options, sourceEnv, "selfEndpoint", "MONAD_SELF_ENDPOINT"));
    writeEnv(env, "MONAD_SELF_TAGS", stringifyList(options.selfTags) || sourceEnv.MONAD_SELF_TAGS);
    writeEnv(env, "MONAD_SELF_TYPE", resolveEnvValue(options, sourceEnv, "selfType", "MONAD_SELF_TYPE"));
    writeEnv(env, "MONAD_SELF_TRUST", resolveEnvValue(options, sourceEnv, "selfTrust", "MONAD_SELF_TRUST"));
    writeEnv(env, "MONAD_SELF_RESOURCES", stringifyList(options.selfResources) || sourceEnv.MONAD_SELF_RESOURCES);
    writeEnv(env, "GUI_PKG_DIST_DIR", resolveEnvValue(options, sourceEnv, "guiPkgDistDir", "GUI_PKG_DIST_DIR"));
    writeEnv(env, "ME_PKG_DIST_DIR", resolveEnvValue(options, sourceEnv, "mePkgDistDir", "ME_PKG_DIST_DIR"));
    writeEnv(env, "CLEAKER_PKG_DIST_DIR", resolveEnvValue(options, sourceEnv, "cleakerPkgDistDir", "CLEAKER_PKG_DIST_DIR"));
    writeEnv(env, "LOCAL_REACT_UMD_DIR", resolveEnvValue(options, sourceEnv, "reactUmdDir", "LOCAL_REACT_UMD_DIR"));
    writeEnv(env, "LOCAL_REACTDOM_UMD_DIR", resolveEnvValue(options, sourceEnv, "reactDomUmdDir", "LOCAL_REACTDOM_UMD_DIR"));
    writeEnv(env, "MONAD_ROUTES_PATH", resolveEnvValue(options, sourceEnv, "routesPath", "MONAD_ROUTES_PATH"));
    writeEnv(env, "MONAD_INDEX_PATH", resolveEnvValue(options, sourceEnv, "indexPath", "MONAD_INDEX_PATH"));
    writeEnv(env, "MONAD_FETCH_TIMEOUT_MS", fetchProxyTimeoutMs);
    const selfNodeConfig = loadSelfNodeConfig({
        cwd,
        env,
        hostname: nodeHostname,
        port,
    });
    const localNamespaceRoot = normalizeNamespaceIdentity(selfNodeConfig?.identity || env.ME_NAMESPACE || nodeHostname);
    return {
        cwd,
        env,
        port,
        nodeHostname,
        nodeDisplayName: `${nodeHostname}:${port}`,
        fetchProxyTimeoutMs,
        mePkgDistDir: resolvePath(cwd, env.ME_PKG_DIST_DIR, "../../../this/.me/npm/dist"),
        cleakerPkgDistDir: resolvePath(cwd, env.CLEAKER_PKG_DIST_DIR, "../../cleaker/npm/dist"),
        guiPkgDistDir: resolvePath(cwd, env.GUI_PKG_DIST_DIR, "../../../this/GUI/npm/dist"),
        reactUmdDir: resolvePath(cwd, env.LOCAL_REACT_UMD_DIR, "../../../this/GUI/npm/node_modules/react/umd"),
        reactDomUmdDir: resolvePath(cwd, env.LOCAL_REACTDOM_UMD_DIR, "../../../this/GUI/npm/node_modules/react-dom/umd"),
        routesPath: resolvePath(cwd, env.MONAD_ROUTES_PATH, "../routes.js"),
        indexPath: resolvePath(cwd, env.MONAD_INDEX_PATH, "../index.html"),
        selfNodeConfig,
        localNamespaceRoot,
    };
}
export async function bootstrapMonad(options = {}) {
    const config = resolveMonadRuntimeConfig(options);
    getKernel();
    const rebuiltProjectedClaims = rebuildProjectedNamespaceClaims();
    const semanticBootstrapRoot = normalizeNamespaceRootName(config.selfNodeConfig?.identity || config.localNamespaceRoot);
    const seededSemanticBootstrap = ensureRootSemanticBootstrap(semanticBootstrapRoot);
    return {
        config,
        kernelStateDir: getKernelStateDir(),
        rebuiltProjectedClaims,
        seededSemanticBootstrap,
    };
}
