// POST: one more attempt to raise the instance of this institution; platform
// admin session only (institutions/detalj.js).
import { obradiPonovi } from "../../../../../../institutions/detalj.js";

const NO_STORE = { "Cache-Control": "no-store" };
const ALLOW = "POST, OPTIONS";

export async function POST(request, { params }) {
  return obradiPonovi(request, (await params).id);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...NO_STORE, Allow: ALLOW } });
}

function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: ALLOW } });
}

export { methodNotAllowed as GET, methodNotAllowed as PUT, methodNotAllowed as PATCH, methodNotAllowed as DELETE };
