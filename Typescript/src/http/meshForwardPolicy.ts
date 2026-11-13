/**
 * meshForwardPolicy.ts -- where this monad may send a request on someone else's behalf.
 *
 * The bridge (handlers/bridgeHandler.ts) forwards reads to mesh endpoints and returns their answer to the caller. An
 * endpoint that came from outside (a /.mesh/announce, or a namespace selector) must never make this monad reach what
 * only it can reach: its own loopback services, link-local/metadata addresses, or -- unless the operator allows it
 * (MONAD_MESH_ALLOW_PRIVATE_ENDPOINTS=1, e.g. a home LAN mesh) -- private networks. Measured before this existed: a
 * self-signed announce for an unclaimed namespace with endpoint http://127.0.0.1:<port>, then one GET /resolve, made
 * the monad fetch that loopback URL and hand the body back.
 *
 * Endpoints this monad wrote itself (self/CLI index entries, which carry no announce `status`) are not checked here:
 * sibling monads on the same machine are loopback by design.
 *
 * Names are resolved and EVERY address must pass. Residual (declared): fetch resolves the name again when it
 * connects, so a name that changes its answer in between (DNS rebinding) is not caught; Node's fetch offers no way to
 * pin the address without an extra dependency. Announces themselves require an operator-listed key
 * (http/meshAnnounce.ts), which is the primary control; this is defense in depth.
 */
import dns from "node:dns/promises";
import net from "node:net";

const ALWAYS_BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],        // "this network" / unspecified
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, cloud metadata
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved + broadcast
] as const) ALWAYS_BLOCKED.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],           // unspecified
  ["::1", 128],          // loopback
  ["fe80::", 10],        // link-local
  ["ff00::", 8],         // multicast
  ["fd00:ec2::", 32],    // AWS metadata over IPv6 (inside fc00::/7, blocked even when private is allowed)
] as const) ALWAYS_BLOCKED.addSubnet(address, prefix, "ipv6");

const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],    // carrier-grade NAT
  ["198.18.0.0", 15],    // benchmarking
] as const) PRIVATE.addSubnet(address, prefix, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6"); // unique local

export type MeshDestinationRefusal =
  | "DESTINATION_SCHEME"
  | "DESTINATION_UNRESOLVABLE"
  | "DESTINATION_BLOCKED"
  | "DESTINATION_PRIVATE";

function privateAllowed(): boolean {
  return process.env.MONAD_MESH_ALLOW_PRIVATE_ENDPOINTS === "1";
}

/** Classifies one IP address (v4, v6, or v4-mapped v6). */
export function classifyAddress(address: string): "blocked" | "private" | "public" {
  let ip = String(address || "").trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return "blocked";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS_BLOCKED.check(ip, type)) return "blocked";
  if (PRIVATE.check(ip, type)) return "private";
  return "public";
}

function refusalFor(kind: "blocked" | "private" | "public"): MeshDestinationRefusal | null {
  if (kind === "blocked") return "DESTINATION_BLOCKED";
  if (kind === "private" && !privateAllowed()) return "DESTINATION_PRIVATE";
  return null;
}

/**
 * Checks a URL without resolving names: scheme, literal IPs and the `localhost` names. For places that cannot wait
 * for DNS (the announce handler); a name still has to pass checkMeshDestination when it is used.
 */
export function checkMeshEndpointSyntax(raw: string): MeshDestinationRefusal | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "DESTINATION_SCHEME"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "DESTINATION_SCHEME";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return "DESTINATION_BLOCKED";
  return net.isIP(host) ? refusalFor(classifyAddress(host)) : null;
}

/** Full check before a request is sent: scheme, then every address the name resolves to. */
export async function checkMeshDestination(url: URL): Promise<MeshDestinationRefusal | null> {
  const syntax = checkMeshEndpointSyntax(url.href);
  if (syntax) return syntax;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return null; // a literal already passed above
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return "DESTINATION_UNRESOLVABLE";
  }
  if (!addresses.length) return "DESTINATION_UNRESOLVABLE";
  for (const { address } of addresses) {
    const refusal = refusalFor(classifyAddress(address));
    if (refusal) return refusal;
  }
  return null;
}
