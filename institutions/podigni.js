// Raises requested instances on Institution_server over HTTP, the only
// channel between the two servers (contract on Ductus#2028 c.6993786629 §2).
// This server has no access to Institution_server's database.
//
// Each instance_provisioning request in zatrazena (or left in u_izradi by an
// earlier run) is sent as
//   POST {INSTITUTION_SERVER_URL}/internal/v1/institutions
//   Authorization: Bearer {DUCTURA_PROVISIONING_TOKEN}
//   {slug, displayName, aaiHomeOrg, oidcIssuer, seats}
// and then:
//   201 or 200          -> aktivna, institutionId kept as institution_server_id
//   409 or 400          -> greska with Institution_server's code (final)
//   anything else, a network error or a timeout -> stays u_izradi, retried
// on the next run (`pnpm instance:podigni`).
import { fileURLToPath } from "node:url";

import { dohvatiPool } from "./db.js";

export const PUTANJA = "/internal/v1/institutions";
export const TIMEOUT_MS = 10_000;
const FORMAT = "ductura-instance-v1";
const ULOGE = ["student", "teacher", "network_engineer", "institution_admin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KOD = /^[a-z0-9_]{1,64}$/;
// Advisory lock class of the provisioner; the second key is the request, so
// one request is never sent by two runs at once.
const LOCK_ID = 110_902;

export class PodizanjeGreska extends Error {
  constructor(poruka) {
    super(poruka);
    this.name = "PodizanjeGreska";
  }
}

const poruka = (s) => String(s).slice(0, 2000);

/**
 * Where and how to reach Institution_server, from the environment.
 * @returns {{url: string, token: string}}
 */
export function konfiguracija(env = process.env) {
  const base = env.INSTITUTION_SERVER_URL;
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new PodizanjeGreska("INSTITUTION_SERVER_URL nije zadan ili nije ispravan URL");
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new PodizanjeGreska("INSTITUTION_SERVER_URL mora biti http(s) URL bez korisnika, upita i sidra");
  }
  const token = env.DUCTURA_PROVISIONING_TOKEN;
  if (typeof token !== "string" || token.length < 32 || !/^[!-~]+$/.test(token)) {
    throw new PodizanjeGreska("DUCTURA_PROVISIONING_TOKEN nije zadan (najmanje 32 znaka)");
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, "")}${PUTANJA}`, token };
}

/** The request body of §2, built from a frozen provisioning payload. */
export function tijeloZahtjeva(p) {
  const ok =
    p &&
    p.format === FORMAT &&
    typeof p.slug === "string" &&
    typeof p.display_name === "string" &&
    typeof p.aai_home_org === "string" &&
    typeof p.oidc_issuer === "string" &&
    p.accounts !== null &&
    typeof p.accounts === "object" &&
    ULOGE.every((u) => Number.isSafeInteger(p.accounts[u]) && p.accounts[u] >= 0);
  if (!ok) throw new PodizanjeGreska(`payload nije ${FORMAT}`);
  return {
    slug: p.slug,
    displayName: p.display_name,
    aaiHomeOrg: p.aai_home_org,
    oidcIssuer: p.oidc_issuer,
    seats: Object.fromEntries(ULOGE.map((u) => [u, p.accounts[u]])),
  };
}

async function procitajJson(res) {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

/**
 * Sends one payload to Institution_server. Never throws: the outcome is
 * aktivna (with institutionId), greska (final, with code) or ponovi (retry).
 * @param {object} payload
 * @param {{url: string, token: string, timeoutMs?: number}} klijent
 */
export async function posaljiInstituciju(payload, { url, token, timeoutMs = TIMEOUT_MS }) {
  let tijelo;
  try {
    tijelo = tijeloZahtjeva(payload);
  } catch (err) {
    return { ishod: "greska", kod: "neispravan_payload", poruka: err.message };
  }
  let res;
  let body;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(tijelo),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await procitajJson(res);
  } catch (err) {
    const istek = err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError";
    return {
      ishod: "ponovi",
      poruka: istek
        ? `Institution_server nije odgovorio u ${timeoutMs / 1000} s`
        : poruka(`Institution_server nedostupan: ${err?.cause?.code ?? err?.message ?? err}`),
    };
  }
  const s = res.status;
  if (s === 201 || s === 200) {
    if (body && typeof body.institutionId === "string" && UUID.test(body.institutionId) && body.slug === tijelo.slug) {
      return { ishod: "aktivna", status: s, institutionId: body.institutionId.toLowerCase() };
    }
    return { ishod: "ponovi", status: s, poruka: `Institution_server je odgovorio ${s} bez ispravnog institutionId` };
  }
  if (s === 409 || s === 400) {
    const kod = typeof body?.greska === "string" && KOD.test(body.greska) ? body.greska : s === 409 ? "sukob" : "neispravan_unos";
    const polje = typeof body?.polje === "string" ? ` (polje ${body.polje.slice(0, 64)})` : "";
    return { ishod: "greska", status: s, kod, poruka: poruka(`Institution_server: ${s} ${kod}${polje}`) };
  }
  if (s === 401) return { ishod: "ponovi", status: s, poruka: "Institution_server odbija token (401)" };
  if (s >= 500) return { ishod: "ponovi", status: s, poruka: `Institution_server: greška ${s}` };
  return { ishod: "ponovi", status: s, poruka: `Institution_server: neočekivan odgovor ${s}` };
}

/**
 * Raises every pending request, oldest first, or only the one given by
 * institutionId. Returns one result per request.
 * @param {{pool?: import("pg").Pool, klijent?: {url: string, token: string, timeoutMs?: number}, institutionId?: string}} [opcije]
 */
export async function podigniInstance({ pool, klijent, institutionId } = {}) {
  const izvor = pool ?? dohvatiPool();
  const veza = klijent ?? konfiguracija();
  const { rows } = await izvor.query(
    `SELECT institution_id FROM institutions.instance_provisioning
     WHERE state IN ('zatrazena', 'u_izradi') AND ($1::uuid IS NULL OR institution_id = $1)
     ORDER BY requested_at, institution_id`,
    [institutionId ?? null],
  );
  const rezultati = [];
  for (const { institution_id: id } of rows) rezultati.push(await podigniJednu(izvor, veza, id));
  return rezultati;
}

async function podigniJednu(izvor, veza, id) {
  const client = await izvor.connect();
  try {
    const {
      rows: [{ ok }],
    } = await client.query("SELECT pg_try_advisory_lock($1, hashtext($2::text)) AS ok", [LOCK_ID, id]);
    if (!ok) return { id, stanje: null, poruka: "zahtjev upravo podiže drugo pokretanje" };
    try {
      const {
        rows: [req],
      } = await client.query(
        `UPDATE institutions.instance_provisioning
         SET state = 'u_izradi', attempts = attempts + 1, last_attempt_at = now()
         WHERE institution_id = $1 AND state IN ('zatrazena', 'u_izradi')
         RETURNING payload`,
        [id],
      );
      if (!req) return { id, stanje: null };
      const slug = req.payload?.slug;
      const r = await posaljiInstituciju(req.payload, veza);
      if (r.ishod === "aktivna") {
        await client.query(
          `UPDATE institutions.instance_provisioning
           SET state = 'aktivna', activated_at = now(), institution_server_id = $2, last_error = NULL
           WHERE institution_id = $1`,
          [id, r.institutionId],
        );
        return { id, slug, stanje: "aktivna", institutionServerId: r.institutionId };
      }
      if (r.ishod === "greska") {
        await client.query(
          `UPDATE institutions.instance_provisioning SET state = 'greska', error_code = $2, last_error = $3
           WHERE institution_id = $1`,
          [id, r.kod, r.poruka],
        );
        return { id, slug, stanje: "greska", kod: r.kod, poruka: r.poruka };
      }
      await client.query(`UPDATE institutions.instance_provisioning SET last_error = $2 WHERE institution_id = $1`, [
        id,
        r.poruka,
      ]);
      return { id, slug, stanje: "u_izradi", poruka: r.poruka };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, hashtext($2::text))", [LOCK_ID, id]);
    }
  } finally {
    client.release();
  }
}

/**
 * Called right after stvoriInstituciju: one attempt for that institution,
 * without waiting for the next `pnpm instance:podigni`. Never throws; the
 * institution exists either way, and a request left behind is raised by the
 * next run. Without INSTITUTION_SERVER_URL and DUCTURA_PROVISIONING_TOKEN the
 * request stays zatrazena.
 */
export async function podigniNakonStvaranja(institutionId, { pool } = {}) {
  let klijent;
  try {
    klijent = konfiguracija();
  } catch (err) {
    console.warn(`instanca ${institutionId} čeka: ${err.message}`);
    return null;
  }
  try {
    const [r] = await podigniInstance({ pool, klijent, institutionId });
    return r ?? null;
  } catch (err) {
    console.error(`instanca ${institutionId}: podizanje nije uspjelo`, err);
    return null;
  }
}

// `pnpm instance:podigni`: DATABASE_URL is this server's database,
// INSTITUTION_SERVER_URL and DUCTURA_PROVISIONING_TOKEN reach
// Institution_server. Exits 1 when any request did not become aktivna.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const klijent = konfiguracija();
  const pool = dohvatiPool();
  try {
    const rezultati = await podigniInstance({ pool, klijent });
    for (const r of rezultati) console.log(`${r.slug ?? r.id}: ${r.stanje ?? "preskočeno"}${r.poruka ? ` (${r.poruka})` : ""}`);
    if (rezultati.some((r) => r.stanje !== "aktivna")) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
