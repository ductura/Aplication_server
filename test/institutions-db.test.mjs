// institutions/ against a real PostgreSQL (`pnpm test:db`). DATABASE_URL must
// name a database whose name contains "test": the suite drops and recreates
// the institutions schema there. Without it the suite fails; it never skips.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import pg from "pg";

import * as route from "../app/api/admin/institutions/route.js";
import { migracije, primijeniMigracije } from "../institutions/migrate.js";
import { InstitucijaGreska, popisInstitucija, stvoriInstituciju } from "../institutions/stvori.js";
import { izdajToken } from "../lib/admin-sesija.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://login.aai.example.hr/oidc";
const SECRET = "k".repeat(40);
let pool;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set for pnpm test:db");
  assert.match(new globalThis.URL(DATABASE_URL).pathname, /test/, "DATABASE_URL must name a test database");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  await pool.query("DROP SCHEMA IF EXISTS institutions CASCADE; DROP TABLE IF EXISTS public.institutions_migration");
  assert.deepEqual(await primijeniMigracije(pool), migracije().map((m) => m.name));
});

after(async () => {
  await pool?.end();
  const { dohvatiPool } = await import("../institutions/db.js");
  await dohvatiPool().end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE institutions.instance_provisioning, institutions.account, institutions.institution");
});

const stvori = (over = {}) =>
  stvoriInstituciju(
    {
      fakultetId: "fpzg",
      aaiDomena: "fpzg.example.hr",
      issuer: ISSUER,
      racuni: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
      ...over,
    },
    { pool },
  );

const count = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);

test("migrations are recorded and a second run applies nothing", async () => {
  assert.deepEqual(await primijeniMigracije(pool), []);
  const { rows } = await pool.query("SELECT name, sha256 FROM public.institutions_migration ORDER BY name");
  assert.deepEqual(rows, migracije().map(({ name, sha256 }) => ({ name, sha256 })));
});

test("a migration changed after it was applied stops the run", async () => {
  await pool.query("UPDATE public.institutions_migration SET sha256 = 'x' WHERE name = '0001_institutions.sql'");
  try {
    await assert.rejects(primijeniMigracije(pool), /0001_institutions\.sql changed/);
  } finally {
    await pool.query("UPDATE public.institutions_migration SET sha256 = $1 WHERE name = '0001_institutions.sql'", [
      migracije()[0].sha256,
    ]);
  }
});

test("stvoriInstituciju stores the faculty, its accounts and the instance request", async () => {
  const inst = await stvori({ aaiDomena: "  FPZG.Example.HR\t" });
  assert.equal(inst.slug, "fpzg");
  assert.equal(inst.naziv, "Fakultet političkih znanosti");
  assert.equal(inst.aaiDomena, "fpzg.example.hr");
  assert.deepEqual(inst.racuni, { student: 200, teacher: 50, institution_admin: 1, network_engineer: 3 });
  assert.equal(inst.provisioning.stanje, "zatrazena");

  const { rows } = await pool.query(
    `SELECT role, count(*)::int AS n, min(ordinal) AS lo, max(ordinal) AS hi, bool_and(requires_fido2) AS fido2,
            bool_and(bound_at IS NULL AND hr_edu_person_unique_id IS NULL) AS free
     FROM institutions.account WHERE institution_id = $1 GROUP BY role ORDER BY role`,
    [inst.id],
  );
  assert.deepEqual(rows, [
    { role: "institution_admin", n: 1, lo: 1, hi: 1, fido2: false, free: true },
    { role: "network_engineer", n: 3, lo: 1, hi: 3, fido2: true, free: true },
    { role: "student", n: 200, lo: 1, hi: 200, fido2: false, free: true },
    { role: "teacher", n: 50, lo: 1, hi: 50, fido2: false, free: true },
  ]);

  const {
    rows: [p],
  } = await pool.query("SELECT state, payload, activated_at FROM institutions.instance_provisioning WHERE institution_id = $1", [
    inst.id,
  ]);
  const admin = await pool.query(
    "SELECT id FROM institutions.account WHERE institution_id = $1 AND role = 'institution_admin'",
    [inst.id],
  );
  assert.equal(p.state, "zatrazena");
  assert.equal(p.activated_at, null);
  assert.deepEqual(p.payload, {
    format: "ductura-instance-v1",
    slug: "fpzg",
    display_name: "Fakultet političkih znanosti",
    aai_home_org: "fpzg.example.hr",
    oidc_issuer: ISSUER,
    settings: { enrollment_attempt_limit: 5, enrollment_attempt_window_seconds: 900 },
    accounts: { student: 200, teacher: 50, institution_admin: 1, network_engineer: 3 },
    first_admin: { account_id: admin.rows[0].id, role: "institution_admin" },
  });
  assert.deepEqual(inst.provisioning.payload, p.payload);
});

test("roles not given get no accounts; the issuer can come from AAI_OIDC_ISSUER", async () => {
  process.env.AAI_OIDC_ISSUER = ISSUER;
  try {
    const inst = await stvori({ issuer: undefined, racuni: { institution_admin: 2 } });
    assert.equal(inst.issuer, ISSUER);
    assert.equal(await count("SELECT count(*) AS n FROM institutions.account WHERE institution_id = $1", [inst.id]), 2);
  } finally {
    delete process.env.AAI_OIDC_ISSUER;
  }
});

test("one faculty is one institution, and one AAI domain belongs to one institution", async () => {
  await stvori();
  for (const over of [{ aaiDomena: "drugi.example.hr" }, { fakultetId: "fer" }]) {
    await assert.rejects(stvori(over), (e) => e instanceof InstitucijaGreska && e.kod === "vec_postoji");
  }
  assert.equal(await count("SELECT count(*) AS n FROM institutions.institution"), 1);
  assert.equal(await count("SELECT count(*) AS n FROM institutions.account"), 254);
  assert.equal(await count("SELECT count(*) AS n FROM institutions.instance_provisioning"), 1);
});

test("everything is one transaction: a failure on the last insert leaves nothing", async () => {
  await pool.query(`CREATE FUNCTION public.fail_once() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$;
    CREATE TRIGGER fail_once BEFORE INSERT ON institutions.instance_provisioning
      FOR EACH ROW EXECUTE FUNCTION public.fail_once()`);
  try {
    await assert.rejects(stvori(), /injected failure/);
  } finally {
    await pool.query("DROP TRIGGER fail_once ON institutions.instance_provisioning; DROP FUNCTION public.fail_once()");
  }
  for (const t of ["institution", "account", "instance_provisioning"]) {
    assert.equal(await count(`SELECT count(*) AS n FROM institutions.${t}`), 0, t);
  }
  assert.equal((await stvori()).slug, "fpzg");
});

test("two parallel requests for one faculty create it once", async () => {
  const results = await Promise.allSettled([stvori(), stvori({ aaiDomena: "drugi.example.hr" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(results.find((r) => r.status === "rejected").reason.kod, "vec_postoji");
  assert.equal(await count("SELECT count(*) AS n FROM institutions.institution"), 1);
});

test("the schema itself refuses rows the module would never write", async () => {
  const bad = [
    ["slug", "INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer) VALUES ('x1', 'X!', 'N', 'x.hr', $1)"],
    ["home org", "INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer) VALUES ('x1', 'x1', 'N', 'X.hr', $1)"],
    ["issuer", "INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer) VALUES ('x1', 'x1', 'N', 'x.hr', 'login.hr')"],
    ["label", "INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer) VALUES ('x1', 'x1', E'N\\u200B', 'x.hr', $1)"],
    ["blank label", "INSERT INTO institutions.institution (fakultet_id, slug, display_name, aai_home_org, oidc_issuer) VALUES ('x1', 'x1', ' ', 'x.hr', $1)"],
  ];
  for (const [name, sql] of bad) {
    await assert.rejects(pool.query(sql, sql.includes("$1") ? [ISSUER] : []), { code: "23514" }, name);
  }
  const inst = await stvori({ racuni: { institution_admin: 1 } });
  await assert.rejects(
    pool.query("INSERT INTO institutions.account (institution_id, role, ordinal) VALUES ($1, 'app_admin', 9)", [inst.id]),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query("UPDATE institutions.account SET bound_at = now() WHERE institution_id = $1", [inst.id]),
    { code: "23514" },
  );
});

test("instance state only moves zatrazena -> u_izradi -> aktivna, and the payload is frozen", async () => {
  const { id } = await stvori();
  const set = (state) =>
    pool.query(
      `UPDATE institutions.instance_provisioning
       SET state = $2, activated_at = CASE WHEN $2 = 'aktivna' THEN now() END WHERE institution_id = $1`,
      [id, state],
    );
  await assert.rejects(set("aktivna"), /from zatrazena to aktivna/);
  await assert.rejects(
    pool.query("UPDATE institutions.instance_provisioning SET payload = '{}' WHERE institution_id = $1", [id]),
    /immutable/,
  );
  await set("u_izradi");
  await assert.rejects(set("zatrazena"), /from u_izradi to zatrazena/);
  await set("aktivna");
  for (const s of ["zatrazena", "u_izradi"]) await assert.rejects(set(s), /from aktivna/);
  const [row] = await popisInstitucija({ pool });
  assert.equal(row.provisioning.stanje, "aktivna");
  assert.ok(row.provisioning.aktivirano instanceof Date);
});

test("bind_account ties a person to a free account of the role at first AAI login", async () => {
  const { id } = await stvori({ racuni: { institution_admin: 1, student: 2 } });
  const bind = (role, unique, issuer = ISSUER) =>
    pool.query("SELECT institutions.bind_account($1, $2, $3, $4) AS id", [id, role, issuer, unique]).then((r) => r.rows[0].id);
  const a = await bind("student", "ana@example.hr");
  assert.equal(await bind("student", "ana@example.hr"), a, "same person, same account");
  const b = await bind("student", "ivo@example.hr");
  assert.notEqual(a, b);
  await assert.rejects(bind("student", "eva@example.hr"), { code: "ZD409" });
  await assert.rejects(bind("institution_admin", "ana@example.hr"), { code: "ZD403" }, "one account per person");
  await assert.rejects(bind("institution_admin", "x@example.hr", "https://other.example.hr"), { code: "ZD403" });
  const { rows } = await pool.query(
    "SELECT ordinal, hr_edu_person_unique_id AS u FROM institutions.account WHERE institution_id = $1 AND role = 'student' ORDER BY ordinal",
    [id],
  );
  assert.deepEqual(rows, [
    { ordinal: 1, u: "ana@example.hr" },
    { ordinal: 2, u: "ivo@example.hr" },
  ]);
});

test("POST and GET /api/admin/institutions over the real database", async () => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = SECRET;
  process.env.AAI_OIDC_ISSUER = ISSUER;
  try {
    const headers = { cookie: `ductura_admin=${izdajToken("ana")}`, "content-type": "application/json" };
    const body = JSON.stringify({
      fakultetId: "fer",
      aaiDomena: "fer.example.hr",
      racuni: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
    });
    const post = () => route.POST(new Request("http://localhost/api/admin/institutions", { method: "POST", headers, body }));
    const res = await post();
    assert.equal(res.status, 201);
    const { institucija } = await res.json();
    assert.equal(institucija.slug, "fer");
    assert.equal(institucija.provisioning.stanje, "zatrazena");

    const again = await post();
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, "vec_postoji");

    const list = await route.GET(new Request("http://localhost/api/admin/institutions", { headers }));
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "no-store");
    const { institucije } = await list.json();
    assert.equal(institucije.length, 1);
    assert.equal(institucije[0].id, institucija.id);
    assert.deepEqual(institucije[0].racuni, { student: 200, teacher: 50, institution_admin: 1, network_engineer: 3 });
    assert.equal(institucije[0].provisioning.stanje, "zatrazena");
  } finally {
    delete process.env.DUCTURA_ADMIN_TOKEN_SECRET;
    delete process.env.AAI_OIDC_ISSUER;
  }
});
