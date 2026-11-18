// stvoriInstituciju: one faculty becomes one institution, with its accounts
// and the request for its instance on Institution_server, in one transaction.
import { dohvatiPool } from "./db.js";
import { nadjiFakultet } from "./fakulteti.js";

// Account kinds of one institution (Institution_server
// docs/account-permissions.md). app_admin is national and has no accounts
// here. Each institution needs its first admin, so institution_admin >= 1.
export const ULOGE = Object.freeze({
  student: { min: 0, max: 50_000 },
  teacher: { min: 0, max: 5_000 },
  institution_admin: { min: 1, max: 20 },
  network_engineer: { min: 0, max: 20 },
});

const HOME_ORG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ISSUER = /^https?:\/\/[!-~]+$/;

export class InstitucijaGreska extends Error {
  constructor(kod, poruka) {
    super(poruka);
    this.name = "InstitucijaGreska";
    this.kod = kod;
  }
}

const neispravno = (poruka) => new InstitucijaGreska("neispravan_unos", poruka);

// Same normalisation as open_session applies to hrEduPersonHomeOrg: trim
// ASCII white space, lower-case ASCII only.
function normalizirajDomenu(aaiDomena) {
  if (typeof aaiDomena !== "string") throw neispravno("aaiDomena mora biti tekst");
  const d = aaiDomena.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (d.length > 253 || !HOME_ORG.test(d)) throw neispravno("aaiDomena nije ispravna domena");
  return d;
}

function provjeriIssuer(issuer) {
  if (typeof issuer !== "string" || issuer.length > 255 || !ISSUER.test(issuer)) {
    throw neispravno("OIDC issuer nije zadan ili nije ispravan (AAI_OIDC_ISSUER)");
  }
  return issuer;
}

function provjeriRacune(racuni) {
  if (racuni === null || typeof racuni !== "object" || Array.isArray(racuni)) {
    throw neispravno("racuni moraju biti objekt uloga i brojeva");
  }
  for (const uloga of Object.keys(racuni)) {
    if (uloga === "app_admin") throw neispravno("app_admin je na razini države, ne ustanove");
    if (!Object.hasOwn(ULOGE, uloga)) throw neispravno(`nepoznata uloga: ${uloga}`);
  }
  const out = {};
  for (const [uloga, { min, max }] of Object.entries(ULOGE)) {
    const n = Object.hasOwn(racuni, uloga) ? racuni[uloga] : 0;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      throw neispravno(`${uloga}: broj računa mora biti cijeli broj od ${min} do ${max}`);
    }
    out[uloga] = n;
  }
  return out;
}

/**
 * @param {{fakultetId: string, aaiDomena: string, racuni: Record<string, number>, issuer?: string}} ulaz
 * @param {{pool?: import("pg").Pool}} [opcije]
 */
export async function stvoriInstituciju(ulaz, { pool } = {}) {
  if (ulaz === null || typeof ulaz !== "object") throw neispravno("ulaz mora biti objekt");
  const fakultet = nadjiFakultet(ulaz.fakultetId);
  if (!fakultet) throw new InstitucijaGreska("nepoznat_fakultet", "fakultetId nije na popisu fakulteta");
  const aaiHomeOrg = normalizirajDomenu(ulaz.aaiDomena);
  const issuer = provjeriIssuer(ulaz.issuer ?? process.env.AAI_OIDC_ISSUER);
  const racuni = provjeriRacune(ulaz.racuni);

  const client = await (pool ?? dohvatiPool()).connect();
  try {
    await client.query("BEGIN");
    const {
      rows: [inst],
    } = await client.query(
      `INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer)
       VALUES ($1, $1, $2, $3, $4)
       RETURNING id, slug, display_name, aai_home_org, oidc_issuer, enrollment_attempt_limit,
                 extract(epoch FROM enrollment_attempt_window)::integer AS enrollment_attempt_window_seconds,
                 created_at`,
      [fakultet.id, fakultet.naziv, aaiHomeOrg, issuer],
    );
    for (const [uloga, n] of Object.entries(racuni)) {
      if (n === 0) continue;
      await client.query(
        `INSERT INTO institutions.account (institution_id, role, ordinal)
         SELECT $1, $2, g FROM generate_series(1, $3::integer) g`,
        [inst.id, uloga, n],
      );
    }
    const {
      rows: [prviAdmin],
    } = await client.query(
      `SELECT id FROM institutions.account
       WHERE institution_id = $1 AND role = 'institution_admin' AND ordinal = 1`,
      [inst.id],
    );
    const payload = {
      format: "ductura-instance-v1",
      slug: inst.slug,
      display_name: inst.display_name,
      aai_home_org: inst.aai_home_org,
      oidc_issuer: inst.oidc_issuer,
      settings: {
        enrollment_attempt_limit: inst.enrollment_attempt_limit,
        enrollment_attempt_window_seconds: inst.enrollment_attempt_window_seconds,
      },
      accounts: racuni,
      first_admin: { account_id: prviAdmin.id, role: "institution_admin" },
    };
    const {
      rows: [prov],
    } = await client.query(
      `INSERT INTO institutions.instance_provisioning (institution_id, payload)
       VALUES ($1, $2) RETURNING state, requested_at`,
      [inst.id, payload],
    );
    await client.query("COMMIT");
    return {
      id: inst.id,
      fakultetId: fakultet.id,
      slug: inst.slug,
      naziv: inst.display_name,
      aaiDomena: inst.aai_home_org,
      issuer: inst.oidc_issuer,
      racuni,
      stvorena: inst.created_at,
      provisioning: { stanje: prov.state, zatrazeno: prov.requested_at, payload },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err?.code === "23505") {
      throw new InstitucijaGreska("vec_postoji", "institucija za taj fakultet ili tu AAI domenu već postoji");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function popisInstitucija({ pool = dohvatiPool() } = {}) {
  const { rows } = await pool.query(
    `SELECT i.id, i.fakultet_id, i.slug, i.display_name, i.aai_home_org, i.oidc_issuer, i.created_at,
            p.state, p.requested_at, p.activated_at,
            (SELECT coalesce(jsonb_object_agg(c.role, c.n), '{}'::jsonb)
               FROM (SELECT a.role, count(*)::integer AS n FROM institutions.account a
                     WHERE a.institution_id = i.id GROUP BY a.role) c) AS racuni
     FROM institutions.institution i
     JOIN institutions.instance_provisioning p ON p.institution_id = i.id
     ORDER BY i.created_at, i.slug`,
  );
  return rows.map((r) => ({
    id: r.id,
    fakultetId: r.fakultet_id,
    slug: r.slug,
    naziv: r.display_name,
    aaiDomena: r.aai_home_org,
    issuer: r.oidc_issuer,
    racuni: r.racuni,
    stvorena: r.created_at,
    provisioning: { stanje: r.state, zatrazeno: r.requested_at, aktivirano: r.activated_at },
  }));
}
