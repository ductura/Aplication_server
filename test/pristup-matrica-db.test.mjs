// Access matrix of every table against a real PostgreSQL (`pnpm test:db`),
// DAN-1531, attack plan on ductura/Aplication_server#15 (N1..N12). Every cell
// is run for real: as the role, inside a transaction that is rolled back.
// Like the other db suites it needs DATABASE_URL on a database whose name
// contains "test", recreates both schemas there, and never skips.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import pg from "pg";

import { primijeniMigracije as migrirajAdmin } from "../admin/migrate.js";
import { APP_ULOGA, stvoriAplikacijskiPool } from "../institutions/db.js";
import { dohvatiDetalj } from "../institutions/detalj.js";
import { primijeniMigracije as migrirajInstitucije } from "../institutions/migrate.js";
import { podigniInstance } from "../institutions/podigni.js";
import { popisInstitucija, stvoriInstituciju } from "../institutions/stvori.js";
import { LAZNI_TOKEN, pokreniLazniInstitutionServer } from "../institutions/test-fixtures/lazni-institution-server.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://login.aai.example.hr/oidc";
// Invented roles that exist only in the test cluster.
const BEZ_PRAVA = "ductura_test_bez_prava";
const TUDJA_PRIJAVA = "ductura_test_tudja_prijava";
const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${"c".repeat(22)}$${"h".repeat(43)}`;

const TABLICE = ["admin.platform_admin", "institutions.account", "institutions.instance_provisioning", "institutions.institution"];
let pool;
let ids;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set for pnpm test:db");
  assert.match(new globalThis.URL(DATABASE_URL).pathname, /test/, "DATABASE_URL must name a test database");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query(`DROP SCHEMA IF EXISTS institutions CASCADE; DROP TABLE IF EXISTS public.institutions_migration;
                    DROP SCHEMA IF EXISTS admin CASCADE; DROP TABLE IF EXISTS public.admin_migration`);
  await migrirajInstitucije(pool);
  await migrirajAdmin(pool);
  for (const [uloga, login] of [[BEZ_PRAVA, "NOLOGIN"], [TUDJA_PRIJAVA, "LOGIN"]]) {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${uloga}')
                      THEN CREATE ROLE ${uloga} ${login}; END IF; END $$`);
  }
  // Seed as the owner: a pending institution, a final one, a bare one without
  // a request, and one admin. All invented.
  const inst = async (slug, state) => {
    const {
      rows: [{ id }],
    } = await pool.query(
      `INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer)
       VALUES ($1, $1, 'Izmišljeni fakultet', $1 || '.example.hr', $2) RETURNING id`,
      [slug, ISSUER],
    );
    await pool.query("INSERT INTO institutions.account (institution_id, role, ordinal) VALUES ($1, 'student', 1)", [id]);
    if (state) {
      await pool.query("INSERT INTO institutions.instance_provisioning (institution_id, payload) VALUES ($1, '{}')", [id]);
      if (state === "aktivna") {
        await pool.query("UPDATE institutions.instance_provisioning SET state = 'u_izradi' WHERE institution_id = $1", [id]);
        await pool.query(
          "UPDATE institutions.instance_provisioning SET state = 'aktivna', activated_at = now() WHERE institution_id = $1",
          [id],
        );
      }
    }
    return id;
  };
  ids = { zatrazena: await inst("test-a", "zatrazena"), aktivna: await inst("test-b", "aktivna"), gola: await inst("test-c", null) };
  await pool.query("INSERT INTO admin.platform_admin (korisnicko_ime, lozinka_hash) VALUES ('demo-admin', $1)", [HASH]);
});

after(async () => {
  await pool?.end();
});

/** Runs sql as the role and rolls back. Returns "ok:<rows>" or the SQLSTATE. */
async function kao(uloga, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${uloga}`);
    const r = await c.query(sql, params);
    return `ok:${r.rowCount}`;
  } catch (err) {
    return err.code ?? err.message;
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

const ODBIJENO = "42501";
const INSERT_INST = `INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer)
  VALUES ('test-n', 'test-n', 'Izmišljeni', 'test-n.example.hr', '${ISSUER}')`;
const INSERT_ACC = (bound) =>
  `INSERT INTO institutions.account (institution_id, role, ordinal${bound ? ", oidc_issuer, hr_edu_person_unique_id, bound_at" : ""})
   VALUES ($1, 'teacher', 9${bound ? `, '${ISSUER}', 'demo-osoba@example.hr', now()` : ""})`;
const INSERT_PROV = (extra = "", vals = "") =>
  `INSERT INTO institutions.instance_provisioning (institution_id, payload${extra}) VALUES ($1, '{}'${vals})`;

// [what, sql, params(ids), expected for ductura_app, expected for a role without grants]
const MATRICA = [
  // admin.platform_admin: read only (N2, N7).
  ["admin.platform_admin SELECT", "SELECT * FROM admin.platform_admin", () => [], "ok:1", ODBIJENO],
  ["admin.platform_admin INSERT", "INSERT INTO admin.platform_admin VALUES ('demo-uljez', $1)", () => [HASH], ODBIJENO, ODBIJENO],
  ["admin.platform_admin UPDATE", "UPDATE admin.platform_admin SET lozinka_hash = $1", () => [HASH], ODBIJENO, ODBIJENO],
  ["admin.platform_admin DELETE", "DELETE FROM admin.platform_admin", () => [], ODBIJENO, ODBIJENO],
  ["admin.platform_admin TRUNCATE", "TRUNCATE admin.platform_admin", () => [], ODBIJENO, ODBIJENO],
  // institutions.institution: read and create (N7).
  ["institutions.institution SELECT", "SELECT * FROM institutions.institution", () => [], "ok:3", ODBIJENO],
  ["institutions.institution INSERT", INSERT_INST, () => [], "ok:1", ODBIJENO],
  ["institutions.institution UPDATE", "UPDATE institutions.institution SET display_name = 'X'", () => [], ODBIJENO, ODBIJENO],
  ["institutions.institution DELETE", "DELETE FROM institutions.institution", () => [], ODBIJENO, ODBIJENO],
  ["institutions.institution TRUNCATE", "TRUNCATE institutions.institution CASCADE", () => [], ODBIJENO, ODBIJENO],
  // institutions.account: read, free seats before the request only (N3, N4, N7).
  ["institutions.account SELECT", "SELECT * FROM institutions.account", () => [], "ok:3", ODBIJENO],
  ["institutions.account INSERT free, no request yet", INSERT_ACC(false), () => [ids.gola], "ok:1", ODBIJENO],
  ["institutions.account INSERT after the request", INSERT_ACC(false), () => [ids.zatrazena], ODBIJENO, ODBIJENO],
  ["institutions.account INSERT already bound", INSERT_ACC(true), () => [ids.gola], ODBIJENO, ODBIJENO],
  [
    "institutions.account UPDATE (bind)",
    `UPDATE institutions.account SET oidc_issuer = '${ISSUER}', hr_edu_person_unique_id = 'demo-osoba', bound_at = now()`,
    () => [],
    ODBIJENO,
    ODBIJENO,
  ],
  ["institutions.account DELETE", "DELETE FROM institutions.account", () => [], ODBIJENO, ODBIJENO],
  ["institutions.account TRUNCATE", "TRUNCATE institutions.account", () => [], ODBIJENO, ODBIJENO],
  [
    "institutions.bind_account EXECUTE",
    "SELECT institutions.bind_account($1, 'student', $2, 'demo-osoba')",
    () => [ids.gola, ISSUER],
    ODBIJENO,
    ODBIJENO,
  ],
  // institutions.instance_provisioning: read, fresh request, advance a pending one (N5, N6, N7).
  ["institutions.instance_provisioning SELECT", "SELECT * FROM institutions.instance_provisioning", () => [], "ok:2", ODBIJENO],
  ["institutions.instance_provisioning INSERT fresh", INSERT_PROV(), () => [ids.gola], "ok:1", ODBIJENO],
  [
    "institutions.instance_provisioning INSERT already aktivna",
    INSERT_PROV(", state, activated_at, institution_server_id", ", 'aktivna', now(), gen_random_uuid()"),
    () => [ids.gola],
    ODBIJENO,
    ODBIJENO,
  ],
  ["institutions.instance_provisioning INSERT with attempts", INSERT_PROV(", attempts", ", 3"), () => [ids.gola], ODBIJENO, ODBIJENO],
  [
    "institutions.instance_provisioning UPDATE pending",
    "UPDATE institutions.instance_provisioning SET state = 'u_izradi', attempts = attempts + 1 WHERE institution_id = $1",
    () => [ids.zatrazena],
    "ok:1",
    ODBIJENO,
  ],
  [
    "institutions.instance_provisioning UPDATE final (aktivna)",
    "UPDATE institutions.instance_provisioning SET last_error = 'x', institution_server_id = gen_random_uuid() WHERE institution_id = $1",
    () => [ids.aktivna],
    "ok:0",
    ODBIJENO,
  ],
  [
    "institutions.instance_provisioning UPDATE payload",
    `UPDATE institutions.instance_provisioning SET payload = '{"slug":"x"}' WHERE institution_id = $1`,
    () => [ids.zatrazena],
    ODBIJENO,
    ODBIJENO,
  ],
  ["institutions.instance_provisioning DELETE", "DELETE FROM institutions.instance_provisioning", () => [], ODBIJENO, ODBIJENO],
  ["institutions.instance_provisioning TRUNCATE", "TRUNCATE institutions.instance_provisioning", () => [], ODBIJENO, ODBIJENO],
  // Migration ledgers and DDL (N1, N10).
  ["public.institutions_migration SELECT", "SELECT * FROM public.institutions_migration", () => [], ODBIJENO, ODBIJENO],
  ["public.institutions_migration INSERT", "INSERT INTO public.institutions_migration VALUES ('9999_x.sql', 'x')", () => [], ODBIJENO, ODBIJENO],
  ["public.admin_migration SELECT", "SELECT * FROM public.admin_migration", () => [], ODBIJENO, ODBIJENO],
  ["public.admin_migration DELETE", "DELETE FROM public.admin_migration", () => [], ODBIJENO, ODBIJENO],
  ["CREATE TABLE in institutions", "CREATE TABLE institutions.uljez (x int)", () => [], ODBIJENO, ODBIJENO],
  ["CREATE TABLE in public", "CREATE TABLE public.uljez (x int)", () => [], ODBIJENO, ODBIJENO],
  ["DROP TABLE", "DROP TABLE institutions.account", () => [], ODBIJENO, ODBIJENO],
  ["ALTER TABLE ... DISABLE RLS", "ALTER TABLE admin.platform_admin DISABLE ROW LEVEL SECURITY", () => [], ODBIJENO, ODBIJENO],
  ["DROP POLICY", "DROP POLICY account_app_create ON institutions.account", () => [], ODBIJENO, ODBIJENO],
];

for (const [sto, sql, params, zaApp, zaOstale] of MATRICA) {
  test(`matrix: ${sto}`, async () => {
    assert.equal(await kao(APP_ULOGA, sql, params()), zaApp, `${APP_ULOGA}: ${sto}`);
    assert.equal(await kao(BEZ_PRAVA, sql, params()), zaOstale, `${BEZ_PRAVA}: ${sto}`);
  });
}

test("every table of admin and institutions has RLS forced and rows in the matrix (N8, N9)", async () => {
  const { rows } = await pool.query(
    `SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('admin', 'institutions') AND c.relkind IN ('r', 'p') ORDER BY (n.nspname || '.' || c.relname) COLLATE "C"`,
  );
  assert.deepEqual(rows.map((r) => r.t), TABLICE, "a new table needs RLS, policies and rows in this matrix");
  for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, `${r.t}: RLS enabled and forced`);
  const pokriveno = new Set(MATRICA.map(([sto]) => sto.split(" ")[0]));
  for (const t of TABLICE) assert.ok(pokriveno.has(t), `${t} has rows in the matrix`);
  // Policies are only for the application role and the owner, never PUBLIC.
  const { rows: pol } = await pool.query(
    `SELECT DISTINCT unnest(roles)::text AS r FROM pg_policies WHERE schemaname IN ('admin', 'institutions')`,
  );
  const vlasnik = (await pool.query("SELECT current_user AS u")).rows[0].u;
  assert.deepEqual(pol.map((p) => p.r).sort(), [APP_ULOGA, vlasnik].sort());
});

test("ductura_app cannot bypass anything and owns nothing (N1)", async () => {
  const {
    rows: [r],
  } = await pool.query(
    `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
            (SELECT count(*)::int FROM pg_class c WHERE c.relowner = pg_roles.oid) AS owns
     FROM pg_roles WHERE rolname = $1`,
    [APP_ULOGA],
  );
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, owns: 0 });
});

test("the migration refuses an existing ductura_app with dangerous attributes (N12)", async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`ALTER ROLE ${APP_ULOGA} BYPASSRLS`);
    await c.query("DELETE FROM public.admin_migration WHERE name = '0002_rls_least_privilege.sql'");
    await c.query("SAVEPOINT s");
    const sql = (await import("../admin/migrate.js")).migracije().find((m) => m.name === "0002_rls_least_privilege.sql").sql;
    await assert.rejects(c.query(sql), /must not be superuser, bypass RLS/);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});

test("the application pool runs as ductura_app even when the login is the owner (N1, N10)", async () => {
  const app = stvoriAplikacijskiPool(DATABASE_URL, { max: 2 });
  try {
    const {
      rows: [r],
    } = await app.query("SELECT current_user AS u, session_user AS s");
    assert.equal(r.u, APP_ULOGA);
    await assert.rejects(app.query("SELECT * FROM public.institutions_migration"), (e) => e.code === ODBIJENO);
    await assert.rejects(app.query("DELETE FROM institutions.account"), (e) => e.code === ODBIJENO);
  } finally {
    await app.end();
  }
});

test("a login that is not a member of ductura_app gets no connection at all (N12)", async () => {
  const url = new globalThis.URL(DATABASE_URL);
  url.username = TUDJA_PRIJAVA;
  url.password = "";
  const app = stvoriAplikacijskiPool(url.toString(), { max: 1 });
  try {
    await assert.rejects(app.query("SELECT 1"), (e) => e.code === ODBIJENO && /ductura_app/.test(e.message));
  } finally {
    await app.end();
  }
});

test("every flow of the application works through the application pool", async () => {
  const lazni = await pokreniLazniInstitutionServer();
  const app = stvoriAplikacijskiPool(DATABASE_URL, { max: 3 });
  try {
    const nova = await stvoriInstituciju(
      { fakultetId: "fer", aaiDomena: "fer.example.hr", issuer: ISSUER, racuni: { student: 2, teacher: 1, institution_admin: 1 } },
      { pool: app },
    );
    assert.equal(nova.provisioning.stanje, "zatrazena");
    const klijent = { url: `${lazni.url}/internal/v1/institutions`, token: LAZNI_TOKEN, timeoutMs: 300 };
    const [r] = await podigniInstance({ pool: app, klijent, institutionId: nova.id });
    assert.equal(r.stanje, "aktivna");
    assert.equal((await dohvatiDetalj(nova.id, { pool: app })).provisioning.stanje, "aktivna");
    assert.ok((await popisInstitucija({ pool: app })).some((i) => i.id === nova.id));
    // aktivna is final for the application: a second run finds nothing to raise.
    assert.deepEqual(await podigniInstance({ pool: app, klijent, institutionId: nova.id }), []);
    assert.deepEqual(await podigniInstance({ pool: app, klijent, institutionId: nova.id, ponoviGresku: true }), []);

    // greska: the admin's retry may take it back to u_izradi (0005), a run may not.
    const odbijena = await stvoriInstituciju(
      { fakultetId: "agr", aaiDomena: "agr.example.hr", issuer: ISSUER, racuni: { institution_admin: 1 } },
      { pool: app },
    );
    lazni.odgovor = () => ({ status: 409, body: { greska: "slug_zauzet" } });
    assert.equal((await podigniInstance({ pool: app, klijent, institutionId: odbijena.id }))[0].stanje, "greska");
    lazni.vratiZadano();
    assert.deepEqual(await podigniInstance({ pool: app, klijent, institutionId: odbijena.id }), []);
    const [ponovo] = await podigniInstance({ pool: app, klijent, institutionId: odbijena.id, ponoviGresku: true, pokusaja: 1 });
    assert.equal(ponovo.stanje, "aktivna");
    assert.equal((await dohvatiDetalj(odbijena.id, { pool: app })).provisioning.kodGreske, null);
  } finally {
    await app.end();
    await lazni.zatvori();
    const nove = "SELECT id FROM institutions.institution WHERE slug IN ('fer', 'agr')";
    await pool.query(`DELETE FROM institutions.instance_provisioning WHERE institution_id IN (${nove})`);
    await pool.query(`DELETE FROM institutions.account WHERE institution_id IN (${nove})`);
    await pool.query("DELETE FROM institutions.institution WHERE slug IN ('fer', 'agr')");
  }
});
