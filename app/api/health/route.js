// Liveness/readiness endpoint for the container HEALTHCHECK and Kubernetes probes.
// The body is constant on purpose: no time, version, environment or secrets.
// Next 16 serves GET route handlers on demand; test/build-output.test.mjs
// fails the build if this route is ever prerendered.

const NO_STORE = { "Cache-Control": "no-store" };

export function GET() {
  return Response.json({ status: "ok" }, { headers: NO_STORE });
}

const ALLOW = "GET, HEAD, OPTIONS";

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...NO_STORE, Allow: ALLOW } });
}

function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: ALLOW } });
}

export { methodNotAllowed as POST, methodNotAllowed as PUT, methodNotAllowed as PATCH };
export { methodNotAllowed as DELETE };
