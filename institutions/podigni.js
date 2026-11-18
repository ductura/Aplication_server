// Raises requested instances: each instance_provisioning request in
// zatrazena (or left in u_izradi by an earlier failed run) is written into
// Institution_server's main database, then marked aktivna.
//
// On Institution_server an institution takes logins once it has
// identity.institution with aai_home_org (open_session), its OIDC issuer in
// identity.institution_issuer, and institution.institution_settings (without
// which nobody can enrol). This writes exactly those three rows, as
// db/main/local/seed.sql does for the demo institutions. The first
// institution admin is appointed there by the operator after that person's
// first AAI@EduHr login, so it stays in the payload (first_admin) and is not
// written here.
//
// Every write is idempotent and checked: an existing slug with another
// home organisation, issuer set or settings stops the request instead of
// being overwritten.
import { fileURLToPath } from "node:url";

import { dohvatiPool } from "./db.js";

const FORMAT = "ductura-instance-v1";
// Arbitrary constant: only one provisioner runs at a time.
const LOCK_ID = 110_902;

export class PodizanjeGreska extends Error {
  constructor(poruka) {
    super(poruka);
    this.name = "PodizanjeGreska";
  }
}

function provjeriPayload(p) {
  const ok =
    p &&
    p.format === FORMAT &&
    typeof p.slug === "string" &&
    typeof p.display_name === "string" &&
    typeof p.aai_home_org === "string" &&
    typeof p.oidc_issuer === "string" &&
    Number.isSafeInteger(p.settings?.enrollment_attempt_limit) &&
    Number.isSafeInteger(p.settings?.enrollment_attempt_window_seconds);
  if (!ok) throw new PodizanjeGreska(`payload nije ${FORMAT}`);
}

/** Writes one payload into Institution_server's main database, in one transaction. */
export async function primijeniNaInstitutionServer(cilj, payload) {
  provjeriPayload(payload);
  const s = payload.settings;
  const client = await cilj.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.institution (slug, aai_home_org) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`,
      [payload.slug, payload.aai_home_org],
    );
    const {
      rows: [inst],
    } = await client.query(`SELECT id, aai_home_org FROM identity.institution WHERE slug = $1 FOR UPDATE`, [payload.slug]);
    if (inst.aai_home_org !== payload.aai_home_org) {
      throw new PodizanjeGreska(`slug ${payload.slug} već postoji s drugom AAI domenom`);
    }
    await client.query(
      `INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [inst.id, payload.oidc_issuer],
    );
    const { rows: issuers } = await client.query(
      `SELECT oidc_issuer FROM identity.institution_issuer WHERE institution_id = $1`,
      [inst.id],
    );
    if (issuers.length !== 1) throw new PodizanjeGreska(`slug ${payload.slug} već ima drugi OIDC issuer`);
    await client.query(
      `INSERT INTO institution.institution_settings
         (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
       VALUES ($1, $2, $3, make_interval(secs => $4)) ON CONFLICT (institution_id) DO NOTHING`,
      [inst.id, payload.display_name, s.enrollment_attempt_limit, s.enrollment_attempt_window_seconds],
    );
    const {
      rows: [set],
    } = await client.query(
      `SELECT display_name, enrollment_attempt_limit,
              extract(epoch FROM enrollment_attempt_window)::integer AS window_seconds
       FROM institution.institution_settings WHERE institution_id = $1`,
      [inst.id],
    );
    if (
      set.display_name !== payload.display_name ||
      set.enrollment_attempt_limit !== s.enrollment_attempt_limit ||
      set.window_seconds !== s.enrollment_attempt_window_seconds
    ) {
      throw new PodizanjeGreska(`slug ${payload.slug} već ima druge postavke`);
    }
    await client.query("COMMIT");
    return inst.id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const poruka = (err) => String(err?.message ?? err).slice(0, 2000);

/**
 * Raises every pending request, oldest first. Returns one result per request.
 * @param {{pool?: import("pg").Pool, cilj: import("pg").Pool}} opcije
 */
export async function podigniInstance({ pool, cilj }) {
  const izvor = pool ?? dohvatiPool();
  const lock = await izvor.connect();
  const rezultati = [];
  try {
    const {
      rows: [{ ok }],
    } = await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_ID]);
    if (!ok) throw new PodizanjeGreska("drugi provisioner već radi");
    try {
      const { rows } = await izvor.query(
        `SELECT institution_id FROM institutions.instance_provisioning
         WHERE state IN ('zatrazena', 'u_izradi') ORDER BY requested_at, institution_id`,
      );
      for (const { institution_id: id } of rows) rezultati.push(await podigniJednu(izvor, cilj, id));
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    lock.release();
  }
  return rezultati;
}

async function podigniJednu(izvor, cilj, id) {
  const {
    rows: [req],
  } = await izvor.query(
    `UPDATE institutions.instance_provisioning
     SET state = 'u_izradi', attempts = attempts + 1, last_attempt_at = now()
     WHERE institution_id = $1 AND state IN ('zatrazena', 'u_izradi')
     RETURNING payload`,
    [id],
  );
  if (!req) return { id, stanje: null };
  try {
    const ciljId = await primijeniNaInstitutionServer(cilj, req.payload);
    await izvor.query(
      `UPDATE institutions.instance_provisioning
       SET state = 'aktivna', activated_at = now(), last_error = NULL WHERE institution_id = $1`,
      [id],
    );
    return { id, slug: req.payload.slug, stanje: "aktivna", institutionServerId: ciljId };
  } catch (err) {
    await izvor.query(`UPDATE institutions.instance_provisioning SET last_error = $2 WHERE institution_id = $1`, [
      id,
      poruka(err),
    ]);
    return { id, slug: req.payload.slug, stanje: "u_izradi", greska: poruka(err) };
  }
}

// `pnpm institutions:podigni`: DATABASE_URL is this server's database,
// INSTITUTION_DATABASE_URL the operator connection to Institution_server's
// main database. Exits 1 when any request is left unfinished.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pg = (await import("pg")).default;
  if (!process.env.INSTITUTION_DATABASE_URL) throw new Error("INSTITUTION_DATABASE_URL is not set");
  const cilj = new pg.Pool({ connectionString: process.env.INSTITUTION_DATABASE_URL, max: 2 });
  const pool = dohvatiPool();
  try {
    const rezultati = await podigniInstance({ pool, cilj });
    for (const r of rezultati) console.log(`${r.slug}: ${r.stanje}${r.greska ? ` (${r.greska})` : ""}`);
    if (rezultati.some((r) => r.stanje !== "aktivna")) process.exitCode = 1;
  } finally {
    await Promise.all([pool.end(), cilj.end()]);
  }
}
