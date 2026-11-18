// Liveness/readiness endpoint for the container HEALTHCHECK and Kubernetes probes.
// The body is constant on purpose: no time, version, environment or secrets.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export function GET() {
  return Response.json({ status: "ok" }, { headers: NO_STORE });
}

export function POST() {
  return new Response(null, {
    status: 405,
    headers: { ...NO_STORE, Allow: "GET, HEAD" },
  });
}
