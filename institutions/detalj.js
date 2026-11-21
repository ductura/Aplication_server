// One institution with the state of its instance request and its attempts,
// and a manual retry of that one request (GET /api/admin/institutions/{id},
// POST /api/admin/institutions/{id}/ponovi). The retry is the same step as
// `pnpm instance:podigni`, for a single institution (institutions/podigni.js).
//
// There is no separate attempts table: every attempt is recorded on the
// instance_provisioning row (attempts, last_attempt_at, last_error, 0002),
// so the history is that summary. Nothing here reads student content.
import { adminIzZahtjeva } from "../lib/admin-sesija.js";
import { dohvatiPool } from "./db.js";
import { konfiguracija, PodizanjeGreska, podigniInstance } from "./podigni.js";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CEKA = new Set(["zatrazena", "u_izradi"]);

const json = (body, status) => Response.json(body, { status, headers: NO_STORE });

/**
 * @param {string} id
 * @returns {Promise<object | null>} null for an unknown or malformed id
 */
export async function dohvatiDetalj(id, { pool = dohvatiPool() } = {}) {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const {
    rows: [r],
  } = await pool.query(
    `SELECT i.id, i.fakultet_id, i.slug, i.display_name, i.aai_home_org, i.oidc_issuer, i.created_at,
            p.state, p.requested_at, p.activated_at, p.institution_server_id, p.error_code, p.last_error,
            p.attempts, p.last_attempt_at,
            (SELECT coalesce(jsonb_object_agg(c.role, c.n), '{}'::jsonb)
               FROM (SELECT a.role, count(*)::integer AS n FROM institutions.account a
                     WHERE a.institution_id = i.id GROUP BY a.role) c) AS racuni
     FROM institutions.institution i
     JOIN institutions.instance_provisioning p ON p.institution_id = i.id
     WHERE i.id = $1`,
    [id.toLowerCase()],
  );
  if (!r) return null;
  return {
    id: r.id,
    fakultetId: r.fakultet_id,
    slug: r.slug,
    naziv: r.display_name,
    aaiDomena: r.aai_home_org,
    issuer: r.oidc_issuer,
    racuni: r.racuni,
    stvorena: r.created_at,
    provisioning: {
      stanje: r.state,
      zatrazeno: r.requested_at,
      aktivirano: r.activated_at,
      institutionServerId: r.institution_server_id,
      kodGreske: r.error_code,
      zadnjaGreska: r.last_error,
    },
    pokusaji: {
      ukupno: r.attempts,
      zadnji: r.last_attempt_at,
      zadnjaGreska: r.last_error,
      kodGreske: r.error_code,
    },
  };
}

const zabranjeno = (request) => (adminIzZahtjeva(request) ? null : json({ error: "nije_prijavljen" }, 401));

/** GET handler body. `deps.dohvati` is replaceable for tests without a database. */
export async function obradiDetalj(request, id, { dohvati = dohvatiDetalj } = {}) {
  const denied = zabranjeno(request);
  if (denied) return denied;
  const detalj = await dohvati(id);
  return detalj ? json({ institucija: detalj }, 200) : json({ error: "nepoznata_institucija" }, 404);
}

/**
 * POST handler body: one attempt for an institution in zatrazena or u_izradi.
 * aktivna and greska are final: 409 without calling Institution_server.
 * `deps` (dohvati, podigni, konfiguriraj) are replaceable for tests.
 */
export async function obradiPonovi(
  request,
  id,
  { dohvati = dohvatiDetalj, podigni = podigniInstance, konfiguriraj = konfiguracija } = {},
) {
  const denied = zabranjeno(request);
  if (denied) return denied;
  const prije = await dohvati(id);
  if (!prije) return json({ error: "nepoznata_institucija" }, 404);
  const stanje = prije.provisioning.stanje;
  if (!CEKA.has(stanje)) return json({ error: "stanje_konacno", stanje }, 409);
  let klijent;
  try {
    klijent = konfiguriraj();
  } catch (err) {
    if (err instanceof PodizanjeGreska) return json({ error: "podizanje_nije_podeseno" }, 503);
    throw err;
  }
  const [rezultat] = await podigni({ klijent, institutionId: prije.id });
  // Another run holds the request, or it left zatrazena/u_izradi meanwhile:
  // no attempt was made by this call.
  if (!rezultat || rezultat.stanje === null) {
    const sada = (await dohvati(id))?.provisioning.stanje ?? stanje;
    return json({ error: CEKA.has(sada) ? "u_toku" : "stanje_konacno", stanje: sada }, 409);
  }
  return json({ institucija: await dohvati(id) }, 200);
}
