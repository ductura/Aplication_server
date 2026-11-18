// GET /api/admin/fakulteti: the faculties an institution can be created from
// (institutions/fakulteti.js, source unizg.hr), for the admin form. Only for a
// signed-in platform admin, like /api/admin/institutions.
import { ostaleMetode } from "../../../../admin/prijava.js";
import { FAKULTETI } from "../../../../institutions/fakulteti.js";
import { adminIzZahtjeva } from "../../../../lib/admin-sesija.js";

const NO_STORE = { "Cache-Control": "no-store" };

export function GET(request) {
  if (!adminIzZahtjeva(request)) return Response.json({ error: "nije_prijavljen" }, { status: 401, headers: NO_STORE });
  const fakulteti = FAKULTETI.map(({ id, naziv, web }) => ({ id, naziv, web }));
  return Response.json({ fakulteti }, { status: 200, headers: NO_STORE });
}

const { OPTIONS, nedopusteno } = ostaleMetode("GET, HEAD, OPTIONS");
export { OPTIONS, nedopusteno as POST, nedopusteno as PUT, nedopusteno as PATCH, nedopusteno as DELETE };
