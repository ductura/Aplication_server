// POST creates an institution from one faculty, GET lists them with the state
// of their instance request. Both sit behind the admin gate in
// institutions/admin.js (TODO: admin session).
import { provjeriAdmina } from "../../../../institutions/admin.js";
import { InstitucijaGreska, popisInstitucija, stvoriInstituciju } from "../../../../institutions/stvori.js";

const NO_STORE = { "Cache-Control": "no-store" };
const ALLOW = "GET, HEAD, POST, OPTIONS";
const MAX_BODY = 16 * 1024;
const STATUS = { neispravan_unos: 400, nepoznat_fakultet: 400, vec_postoji: 409 };

const json = (body, status) => Response.json(body, { status, headers: NO_STORE });

function zabranjeno(request) {
  const denied = provjeriAdmina(request);
  return denied && json({ error: denied.error }, denied.status);
}

export async function GET(request) {
  const denied = zabranjeno(request);
  if (denied) return denied;
  return json({ institucije: await popisInstitucija() }, 200);
}

export async function POST(request) {
  const denied = zabranjeno(request);
  if (denied) return denied;
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json({ error: "ocekuje_se_json" }, 415);
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY) return json({ error: "prevelik_zahtjev" }, 413);
  let ulaz;
  try {
    ulaz = JSON.parse(text);
  } catch {
    return json({ error: "neispravan_json" }, 400);
  }
  if (ulaz === null || typeof ulaz !== "object" || Array.isArray(ulaz)) {
    return json({ error: "neispravan_unos", poruka: "tijelo mora biti objekt" }, 400);
  }
  try {
    const { fakultetId, aaiDomena, racuni, issuer } = ulaz;
    return json({ institucija: await stvoriInstituciju({ fakultetId, aaiDomena, racuni, issuer }) }, 201);
  } catch (err) {
    if (err instanceof InstitucijaGreska) return json({ error: err.kod, poruka: err.message }, STATUS[err.kod]);
    throw err;
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...NO_STORE, Allow: ALLOW } });
}

function methodNotAllowed() {
  return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: ALLOW } });
}

export { methodNotAllowed as PUT, methodNotAllowed as PATCH, methodNotAllowed as DELETE };
