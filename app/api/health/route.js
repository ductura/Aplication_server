// Liveness/readiness endpoint for the container HEALTHCHECK and Kubernetes probes.
// The body is constant on purpose: no time, version, environment or secrets.
// Next 16 serves GET route handlers on demand; test/build-output.test.mjs
// fails the build if this route is ever prerendered.

const NO_STORE = { "Cache-Control": "no-store" };

export function GET() {
  return Response.json({ status: "ok" }, { headers: NO_STORE });
}

export function POST() {
  return new Response(null, {
    status: 405,
    headers: { ...NO_STORE, Allow: "GET, HEAD, OPTIONS" },
  });
}
