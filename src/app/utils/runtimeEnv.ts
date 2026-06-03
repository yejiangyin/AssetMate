export function isLocalDevHost() {
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env;
  if (env?.DEV) return true;
  if (typeof window === "undefined") return false;
  const { protocol, hostname } = window.location;
  return protocol.startsWith("http") && /^(localhost|127\.0\.0\.1|::1)$/i.test(hostname);
}
