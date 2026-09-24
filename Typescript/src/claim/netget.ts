// netget.* is reserved for a namespace's own physical-resource config
// (domains, ports, certs, delegates -- see Surface-Identity-Claims.md
// §7.1/§7.7 in the cleaker repo's typedocs). Unlike keychain.ts's
// isKeychainReservedPath()/gatewayAuthority.ts's isGatewayAuthorityReservedPath(),
// this is not routed to a dedicated API -- once the target namespace is
// claimed, it's ordinary namespace data, gated by the same signature check
// as any other write. What makes it reserved is only that an UNCLAIMED
// namespace has no claim to check a signature against at all, so writes to
// this specific branch must be refused outright rather than silently
// allowed unsigned (see commandHandler.ts's rootCommandHandler and
// syncHandler.ts's commitHandler, the two call sites that check this).
//
// Extracted to its own module (rather than staying local to
// commandHandler.ts, its original home) once a second real call site
// (commitHandler) needed it -- same reasoning as why the keychain/gateway-
// authority checks already live in their own files.
export function isNetgetReservedPath(pathInput: string): boolean {
  const path = String(pathInput || "").trim();
  return path === "netget" || path.startsWith("netget.");
}
