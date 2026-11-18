// The provisioner against two real databases (`pnpm test:db`): this server's
// (DATABASE_URL) and a stand-in for Institution_server's main database,
// created next to it as <name>_cilj from institutions/test-fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import pg from "pg";

import { primijeniMigracije } from "../institutions/migrate.js";
import { podigniInstance, primijeniNaInstitutionServer } from "../institutions/podigni.js";
import { stvoriInstituciju } from "../institutions/stvori.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "https://login.aai.example.hr/oidc";
const FIXTURE = readFileSync(new URL("../institutions/test-fixtures/institution-server.sql", import.meta.url), "utf8");
let pool;
let cilj;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set for pnpm test:db");
  const url = new globalThis.URL(DATABASE_URL);
  assert.match(url.pathname, /test/, "DATABASE_URL must name a test database");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query("DROP SCHEMA IF EXISTS institutions CASCADE; DROP TABLE IF EXISTS public.institutions_migration");
  await primijeniMigracije(pool);
  const name = `${url.pathname.slice(1)}_cilj`;
  assert.match(name, /^[a-z0-9_]+$/);
  await pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await pool.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  cilj = new pg.Pool({ connectionString: url.href, max: 4 });
  await cilj.query(FIXTURE);
});

after(async () => {
  await pool?.end();
  await cilj?.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE institutions.instance_provisioning, institutions.account, institutions.institution");
  await cilj.query("TRUNCATE identity.institution_issuer, institution.institution_settings, identity.institution");
});

const stvori = (fakultetId, aaiDomena) =>
  stvoriInstituciju({ fakultetId, aaiDomena, issuer: ISSUER, racuni: { student: 3, institution_admin: 1 } }, { pool });

const stanje = async (id) =>
  (await pool.query("SELECT state, attempts, last_error, activated_at FROM institutions.instance_provisioning WHERE institution_id = $1", [id]))
    .rows[0];

test("a requested instance is written into Institution_server and becomes aktivna", async () => {
  const fpzg = await stvori("fpzg", "fpzg.example.hr");
  const fer = await stvori("fer", "fer.example.hr");
  const rez = await podigniInstance({ pool, cilj });
  assert.deepEqual(
    rez.map((r) => [r.slug, r.stanje]),
    [
      ["fpzg", "aktivna"],
      ["fer", "aktivna"],
    ],
  );
  for (const inst of [fpzg, fer]) {
    const s = await stanje(inst.id);
    assert.equal(s.state, "aktivna");
    assert.equal(s.attempts, 1);
    assert.equal(s.last_error, null);
    assert.ok(s.activated_at instanceof Date);
  }
  const { rows } = await cilj.query(
    `SELECT i.slug, i.aai_home_org, ii.oidc_issuer, s.display_name, s.enrollment_attempt_limit,
            extract(epoch FROM s.enrollment_attempt_window)::int AS win
     FROM identity.institution i
     JOIN identity.institution_issuer ii ON ii.institution_id = i.id
     JOIN institution.institution_settings s ON s.institution_id = i.id ORDER BY i.slug`,
  );
  assert.deepEqual(rows, [
    { slug: "fer", aai_home_org: "fer.example.hr", oidc_issuer: ISSUER, display_name: "Fakultet elektrotehnike i računarstva", enrollment_attempt_limit: 5, win: 900 },
    { slug: "fpzg", aai_home_org: "fpzg.example.hr", oidc_issuer: ISSUER, display_name: "Fakultet političkih znanosti", enrollment_attempt_limit: 5, win: 900 },
  ]);
  assert.deepEqual(await podigniInstance({ pool, cilj }), [], "nothing left to raise");
});

test("a conflict on Institution_server leaves the request in u_izradi with the reason, and nothing half written", async () => {
  await cilj.query("INSERT INTO identity.institution (slug, aai_home_org) VALUES ('fpzg', 'drugo.example.hr')");
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const [r] = await podigniInstance({ pool, cilj });
  assert.equal(r.stanje, "u_izradi");
  assert.match(r.greska, /drugom AAI domenom/);
  const s = await stanje(id);
  assert.equal(s.state, "u_izradi");
  assert.equal(s.attempts, 1);
  assert.match(s.last_error, /drugom AAI domenom/);
  assert.equal(Number((await cilj.query("SELECT count(*) FROM identity.institution_issuer")).rows[0].count), 0);
  assert.equal(Number((await cilj.query("SELECT count(*) FROM institution.institution_settings")).rows[0].count), 0);

  // The operator clears the conflict; the next run retries and finishes.
  await cilj.query("UPDATE identity.institution SET aai_home_org = 'fpzg.example.hr' WHERE slug = 'fpzg'");
  const [again] = await podigniInstance({ pool, cilj });
  assert.equal(again.stanje, "aktivna");
  const done = await stanje(id);
  assert.equal(done.attempts, 2);
  assert.equal(done.last_error, null);
});

test("an existing institution with another issuer or other settings is never overwritten", async () => {
  const { rows } = await cilj.query("INSERT INTO identity.institution (slug, aai_home_org) VALUES ('fpzg', 'fpzg.example.hr') RETURNING id");
  await cilj.query("INSERT INTO identity.institution_issuer VALUES ($1, 'https://drugi.example.hr')", [rows[0].id]);
  const a = await stvori("fpzg", "fpzg.example.hr");
  assert.match((await podigniInstance({ pool, cilj }))[0].greska, /drugi OIDC issuer/);
  assert.equal((await stanje(a.id)).state, "u_izradi");

  await cilj.query("DELETE FROM identity.institution_issuer");
  await cilj.query("INSERT INTO institution.institution_settings (institution_id, display_name) VALUES ($1, 'Drugi naziv')", [rows[0].id]);
  assert.match((await podigniInstance({ pool, cilj }))[0].greska, /druge postavke/);
  assert.equal(Number((await cilj.query("SELECT count(*) FROM identity.institution_issuer")).rows[0].count), 0, "rolled back");
});

test("writing the same payload twice is idempotent", async () => {
  const inst = await stvori("fpzg", "fpzg.example.hr");
  const a = await primijeniNaInstitutionServer(cilj, inst.provisioning.payload);
  const b = await primijeniNaInstitutionServer(cilj, inst.provisioning.payload);
  assert.equal(a, b);
  assert.equal(Number((await cilj.query("SELECT count(*) FROM identity.institution")).rows[0].count), 1);
  await assert.rejects(primijeniNaInstitutionServer(cilj, { ...inst.provisioning.payload, format: "x" }), /payload/);
});

test("only one provisioner runs at a time", async () => {
  await stvori("fpzg", "fpzg.example.hr");
  const holder = await pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(110902)");
    await assert.rejects(podigniInstance({ pool, cilj }), /drugi provisioner/);
  } finally {
    await holder.query("SELECT pg_advisory_unlock(110902)");
    holder.release();
  }
});
