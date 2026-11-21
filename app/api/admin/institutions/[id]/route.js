// GET one institution with its instance request and attempts; platform admin
// session only (institutions/detalj.js).
import { obradiDetalj } from "../../../../../institutions/detalj.js";

const NO_STORE = { "Cache-Control": "no-store" };
const ALLOW = "GET, HEAD, OPTIONS";

export async function GET(request, { params }) {
  return obradiDetalj(request, (await params).id);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...NO_STORE, Allow: ALLOW } });
}

function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: ALLOW } });
}

export { methodNotAllowed as POST, methodNotAllowed as PUT, methodNotAllowed as PATCH, methodNotAllowed as DELETE };
