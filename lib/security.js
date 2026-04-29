// Shared security utilities — imported by API route handlers.
// Files prefixed with _ are ignored by Next.js router.

/**
 * Sets CORS headers and returns whether the request origin is allowed.
 * In production (FRONTEND_ORIGIN env var set): only that origin is granted.
 * In dev (no env var): reflects the request origin (permissive).
 */
export function setCORS(req, res) {
  const origin = req.headers.origin || "";
  const allowed = process.env.FRONTEND_ORIGIN;
  const ok = !allowed || origin === allowed;
  if (ok) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  return ok;
}

/**
 * Validates that a base64 string encodes a real PDF by checking
 * the %PDF- magic number in the first decoded bytes.
 */
export function isPDFBase64(b64) {
  try {
    const head = Buffer.from(b64.slice(0, 8), "base64");
    return head.slice(0, 5).toString("utf8") === "%PDF-";
  } catch {
    return false;
  }
}
