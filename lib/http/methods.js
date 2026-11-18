// Shared answers for HTTP methods a read-only route does not support.
export const NO_STORE = { "Cache-Control": "no-store" };
const ALLOW = "GET, HEAD, OPTIONS";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...NO_STORE, Allow: ALLOW } });
}

export function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: ALLOW } });
}
