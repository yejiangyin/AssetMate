/**
 * Generate a UUID v4 string with a graceful fallback for non-secure contexts.
 *
 * `crypto.randomUUID()` is only available in secure contexts (https or
 * chrome-extension://). When the extension is loaded via http://localhost for
 * debugging, or when an older Chromium version lacks the API, we fall back to a
 * RFC-4122 v4-shaped string assembled from `crypto.getRandomValues` (which is
 * available in all modern browsers regardless of context) and finally to a
 * timestamp+Math.random fallback for very old runtimes.
 */
export function safeUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Some runtimes throw in non-secure contexts; fall through to the fallback.
    }
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Per RFC 4124 §4.4: set version (7) and variant (10xx) bits.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }

  // Last resort: timestamp + Math.random. Not cryptographically strong, but
  // sufficient for client-side id generation inside the extension popup.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 14)}`;
}
