// The provisioner against this server's real database (`pnpm test:db`,
// DATABASE_URL) and a fake Institution_server over HTTP. This server has no
// connection to Institution_server's database.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import pg from "pg";

import * as route from "../app/api/admin/institutions/route.js";
import { primijeniMigracije } from "../institutions/migrate.js";
import { podigniInstance, podigniNakonStvaranja } from "../institutions/podigni.js";
import { popisInstitucija, stvoriInstituciju } from "../institutions/stvori.js";
import { LAZNI_TOKEN, pokreniLazniInstitutionServer } from "../institutions/test-fixtures/lazni-institution-server.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "http://localhost:8090";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV = ["INSTITUTION_SERVER_URL", "DUCTURA_PROVISIONING_TOKEN", "INSTITUTIONS_ADMIN_TOKEN", "AAI_OIDC_ISSUER"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let pool;
let lazni;
let klijent;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set for pnpm test:db");
  assert.match(new globalThis.URL(DATABASE_URL).pathname, /test/, "DATABASE_URL must name a test database");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query("DROP SCHEMA IF EXISTS institutions CASCADE; DROP TABLE IF EXISTS public.institutions_migration");
  await primijeniMigracije(pool);
  lazni = await pokreniLazniInstitutionServer();
});

after(async () => {
  await pool?.end();
  await lazni?.zatvori();
  // The route uses the shared pool from institutions/db.js.
  const { dohvatiPool } = await import("../institutions/db.js");
  await dohvatiPool().end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE institutions.instance_provisioning, institutions.account, institutions.institution");
  lazni.zahtjevi.length = 0;
  lazni.vratiZadano();
  klijent = { url: `${lazni.url}/internal/v1/institutions`, token: LAZNI_TOKEN, timeoutMs: 300 };
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const stvori = (fakultetId, aaiDomena, racuni = { student: 3, teacher: 2, institution_admin: 1 }) =>
  stvoriInstituciju({ fakultetId, aaiDomena, issuer: ISSUER, racuni }, { pool });

const stanje = async (id) =>
  (
    await pool.query(
      `SELECT state, attempts, last_error, error_code, institution_server_id, activated_at
       FROM institutions.instance_provisioning WHERE institution_id = $1`,
      [id],
    )
  ).rows[0];

test("201: requested instances are sent to Institution_server and become aktivna with its institutionId", async () => {
  const fpzg = await stvori("fpzg", "fpzg.example.hr", { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 });
  const fer = await stvori("fer", "fer.example.hr");
  const rez = await podigniInstance({ pool, klijent });
  assert.deepEqual(
    rez.map((r) => [r.slug, r.stanje]),
    [
      ["fpzg", "aktivna"],
      ["fer", "aktivna"],
    ],
  );
  assert.deepEqual(lazni.zahtjevi[0].tijelo, {
    slug: "fpzg",
    displayName: "Fakultet političkih znanosti",
    aaiHomeOrg: "fpzg.example.hr",
    oidcIssuer: ISSUER,
    seats: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
  });
  assert.equal(lazni.zahtjevi[0].headers.authorization, `Bearer ${LAZNI_TOKEN}`);
  for (const [inst, r] of [
    [fpzg, rez[0]],
    [fer, rez[1]],
  ]) {
    const s = await stanje(inst.id);
    assert.equal(s.state, "aktivna");
    assert.equal(s.attempts, 1);
    assert.equal(s.last_error, null);
    assert.match(s.institution_server_id, UUID);
    assert.equal(s.institution_server_id, r.institutionServerId);
    assert.ok(s.activated_at instanceof Date);
  }
  assert.deepEqual(await podigniInstance({ pool, klijent }), [], "nothing left to raise");
  assert.equal(lazni.zahtjevi.length, 2);
  const [row] = await popisInstitucija({ pool });
  assert.equal(row.provisioning.institutionServerId, rez[0].institutionServerId);
});

test("200 (already on Institution_server with the same data): aktivna", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const institutionId = "3f1c2b8e-7a4d-4e1b-9c2a-5d6e7f8a9b0c";
  lazni.odgovor = (t) => ({ status: 200, body: { institutionId, slug: t.slug, status: "aktivna" } });
  assert.equal((await podigniInstance({ pool, klijent }))[0].stanje, "aktivna");
  assert.equal((await stanje(id)).institution_server_id, institutionId);
});

for (const [status, body, kod] of [
  [409, { greska: "slug_zauzet" }, "slug_zauzet"],
  [409, { greska: "domena_zauzeta" }, "domena_zauzeta"],
  [400, { greska: "neispravan_unos", polje: "displayName" }, "neispravan_unos"],
]) {
  test(`${status} ${kod}: greska with the code, final and not retried`, async () => {
    const { id } = await stvori("fpzg", "fpzg.example.hr");
    lazni.odgovor = () => ({ status, body });
    const [r] = await podigniInstance({ pool, klijent });
    assert.equal(r.stanje, "greska");
    assert.equal(r.kod, kod);
    const s = await stanje(id);
    assert.equal(s.state, "greska");
    assert.equal(s.error_code, kod);
    assert.match(s.last_error, new RegExp(`${status} ${kod}`));
    assert.equal(s.institution_server_id, null);
    assert.equal(s.activated_at, null);
    assert.deepEqual(await podigniInstance({ pool, klijent }), [], "greska is not retried");
    assert.equal(lazni.zahtjevi.length, 1);
    const [row] = await popisInstitucija({ pool });
    assert.equal(row.provisioning.stanje, "greska");
    assert.equal(row.provisioning.kodGreske, kod);
  });
}

for (const [naziv, postavi, razlog] of [
  ["401 (wrong token)", (k) => ({ ...k, token: "z".repeat(40) }), /odbija token \(401\)/],
  ["5xx", (k) => ((lazni.odgovor = () => ({ status: 503, body: {} })), k), /greška 503/],
  ["timeout", (k) => ((lazni.odgovor = () => "visi"), k), /nije odgovorio u 0.3 s/],
  ["network error", (k) => ({ ...k, url: "http://127.0.0.1:1/internal/v1/institutions" }), /nedostupan/],
]) {
  test(`${naziv}: stays u_izradi with the reason, and the next run retries it`, async () => {
    const { id } = await stvori("fpzg", "fpzg.example.hr");
    const [r] = await podigniInstance({ pool, klijent: postavi(klijent) });
    assert.equal(r.stanje, "u_izradi");
    assert.match(r.poruka, razlog);
    const s = await stanje(id);
    assert.equal(s.state, "u_izradi");
    assert.equal(s.attempts, 1);
    assert.match(s.last_error, razlog);
    assert.doesNotMatch(s.last_error, /z{32}|lazni-provisioning/, "no token in the stored error");

    lazni.vratiZadano();
    const [again] = await podigniInstance({ pool, klijent });
    assert.equal(again.stanje, "aktivna");
    const done = await stanje(id);
    assert.equal(done.attempts, 2);
    assert.equal(done.last_error, null);
    assert.match(done.institution_server_id, UUID);
  });
}

test("a request another run is raising right now is skipped, not sent twice", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const holder = await pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(110902, hashtext($1::text))", [id]);
    const [r] = await podigniInstance({ pool, klijent });
    assert.equal(r.stanje, null);
    assert.equal(lazni.zahtjevi.length, 0);
    assert.equal((await stanje(id)).state, "zatrazena");
  } finally {
    await holder.query("SELECT pg_advisory_unlock(110902, hashtext($1::text))", [id]);
    holder.release();
  }
  assert.equal((await podigniInstance({ pool, klijent }))[0].stanje, "aktivna");
});

test("state greska only follows u_izradi, carries a code and is final", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const set = (state, kod = "slug_zauzet") =>
    pool.query("UPDATE institutions.instance_provisioning SET state = $2, error_code = $3 WHERE institution_id = $1", [id, state, kod]);
  await assert.rejects(set("greska"), /from zatrazena to greska/);
  await pool.query("UPDATE institutions.instance_provisioning SET state = 'u_izradi' WHERE institution_id = $1", [id]);
  await assert.rejects(set("greska", null), { code: "23514" });
  await assert.rejects(set("greska", "Nije kod"), { code: "23514" });
  await set("greska");
  for (const s of ["zatrazena", "u_izradi"]) await assert.rejects(set(s), /from greska/);
  await assert.rejects(
    pool.query(
      "UPDATE institutions.instance_provisioning SET institution_server_id = gen_random_uuid() WHERE institution_id = $1",
      [id],
    ),
    { code: "23514" },
    "institution_server_id only on aktivna",
  );
});

test("podigniNakonStvaranja raises only that institution, and waits without configuration", async () => {
  const fer = await stvori("fer", "fer.example.hr");
  const fpzg = await stvori("fpzg", "fpzg.example.hr");
  delete process.env.INSTITUTION_SERVER_URL;
  process.env.DUCTURA_PROVISIONING_TOKEN = LAZNI_TOKEN;
  assert.equal(await podigniNakonStvaranja(fpzg.id, { pool }), null);
  assert.equal((await stanje(fpzg.id)).state, "zatrazena");
  assert.equal(lazni.zahtjevi.length, 0);

  process.env.INSTITUTION_SERVER_URL = lazni.url;
  const r = await podigniNakonStvaranja(fpzg.id, { pool });
  assert.equal(r.stanje, "aktivna");
  assert.equal(lazni.zahtjevi.length, 1);
  assert.equal((await stanje(fer.id)).state, "zatrazena", "other requests wait for their own run");
});

test("POST /api/admin/institutions raises the instance at once and answers with its state", async () => {
  process.env.INSTITUTIONS_ADMIN_TOKEN = "t".repeat(40);
  process.env.INSTITUTION_SERVER_URL = lazni.url;
  process.env.DUCTURA_PROVISIONING_TOKEN = LAZNI_TOKEN;
  const post = (body) =>
    route.POST(
      new Request("http://localhost/api/admin/institutions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${"t".repeat(40)}` },
        body: JSON.stringify(body),
      }),
    );
  const res = await post({ fakultetId: "fpzg", aaiDomena: "fpzg.example.hr", issuer: ISSUER, racuni: { student: 2, institution_admin: 1 } });
  assert.equal(res.status, 201);
  const { institucija } = await res.json();
  assert.equal(institucija.provisioning.stanje, "aktivna");
  assert.match(institucija.provisioning.institutionServerId, UUID);
  assert.equal(lazni.zahtjevi.length, 1);
  assert.deepEqual(lazni.zahtjevi[0].tijelo.seats, { student: 2, teacher: 0, network_engineer: 0, institution_admin: 1 });

  // Institution_server refuses: the institution is still created (201) and
  // the answer says why the instance is not there.
  lazni.odgovor = () => ({ status: 409, body: { greska: "domena_zauzeta" } });
  const res2 = await post({ fakultetId: "fer", aaiDomena: "fer.example.hr", issuer: ISSUER, racuni: { institution_admin: 1 } });
  assert.equal(res2.status, 201);
  const p2 = (await res2.json()).institucija.provisioning;
  assert.equal(p2.stanje, "greska");
  assert.equal(p2.kodGreske, "domena_zauzeta");

  // Institution_server down: still 201, the request waits in u_izradi.
  lazni.odgovor = () => ({ status: 502, body: {} });
  const res3 = await post({ fakultetId: "agr", aaiDomena: "agr.example.hr", issuer: ISSUER, racuni: { institution_admin: 1 } });
  assert.equal(res3.status, 201);
  assert.equal((await res3.json()).institucija.provisioning.stanje, "u_izradi");
});
