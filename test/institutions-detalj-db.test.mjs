// Detail and retry of one institution against the real database
// (`pnpm test:db`, DATABASE_URL) and a fake Institution_server over HTTP.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import pg from "pg";

import * as detaljRoute from "../app/api/admin/institutions/[id]/route.js";
import * as ponoviRoute from "../app/api/admin/institutions/[id]/ponovi/route.js";
import { primijeniMigracije } from "../institutions/migrate.js";
import { podigniInstance } from "../institutions/podigni.js";
import { stvoriInstituciju } from "../institutions/stvori.js";
import { LAZNI_TOKEN, pokreniLazniInstitutionServer } from "../institutions/test-fixtures/lazni-institution-server.js";
import { izdajToken } from "../lib/admin-sesija.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ISSUER = "http://localhost:8090";
const ENV = ["INSTITUTION_SERVER_URL", "DUCTURA_PROVISIONING_TOKEN", "DUCTURA_ADMIN_TOKEN_SECRET"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let pool;
let lazni;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set for pnpm test:db");
  assert.match(new globalThis.URL(DATABASE_URL).pathname, /test/, "DATABASE_URL must name a test database");
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  await pool.query("DROP SCHEMA IF EXISTS institutions CASCADE; DROP TABLE IF EXISTS public.institutions_migration");
  await primijeniMigracije(pool);
  lazni = await pokreniLazniInstitutionServer();
});

after(async () => {
  await pool?.end();
  await lazni?.zatvori();
  const { dohvatiPool } = await import("../institutions/db.js");
  await dohvatiPool().end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE institutions.instance_provisioning, institutions.account, institutions.institution");
  lazni.zahtjevi.length = 0;
  lazni.vratiZadano();
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "t".repeat(40);
  process.env.INSTITUTION_SERVER_URL = lazni.url;
  process.env.DUCTURA_PROVISIONING_TOKEN = LAZNI_TOKEN;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const stvori = (fakultetId, aaiDomena) =>
  stvoriInstituciju({ fakultetId, aaiDomena, issuer: ISSUER, racuni: { student: 3, teacher: 2, institution_admin: 1 } }, { pool });

const zahtjev = (id, method, sufiks = "") =>
  new Request(`http://localhost/api/admin/institutions/${id}${sufiks}`, {
    method,
    headers: { cookie: `ductura_admin=${izdajToken("ana")}` },
  });
const get = (id) => detaljRoute.GET(zahtjev(id, "GET"), { params: Promise.resolve({ id }) });
const ponovi = (id) => ponoviRoute.POST(zahtjev(id, "POST", "/ponovi"), { params: Promise.resolve({ id }) });
const klijent = () => ({ url: `${lazni.url}/internal/v1/institutions`, token: LAZNI_TOKEN, timeoutMs: 300 });

test("GET returns the institution with its request state, account counts and attempts", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const res = await get(id);
  assert.equal(res.status, 200);
  const { institucija } = await res.json();
  assert.equal(institucija.id, id);
  assert.equal(institucija.slug, "fpzg");
  assert.deepEqual(institucija.racuni, { student: 3, teacher: 2, institution_admin: 1 });
  assert.equal(institucija.provisioning.stanje, "zatrazena");
  assert.deepEqual(institucija.pokusaji, { ukupno: 0, zadnji: null, zadnjaGreska: null, kodGreske: null });
  assert.equal(JSON.stringify(institucija).includes("payload"), false);
  assert.equal((await get("3f1c2b8e-7a4d-4e1b-9c2a-5d6e7f8a9b0c")).status, 404);
  assert.equal((await get("nije-uuid")).status, 404);
});

test("ponovi turns u_izradi into aktivna and records a new attempt", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  lazni.odgovor = () => ({ status: 503, body: {} });
  assert.equal((await podigniInstance({ pool, klijent: klijent() }))[0].stanje, "u_izradi");
  let { institucija } = await (await get(id)).json();
  assert.equal(institucija.provisioning.stanje, "u_izradi");
  assert.equal(institucija.pokusaji.ukupno, 1);
  assert.match(institucija.pokusaji.zadnjaGreska, /greška 503/);

  lazni.vratiZadano();
  const res = await ponovi(id);
  assert.equal(res.status, 200);
  institucija = (await res.json()).institucija;
  assert.equal(institucija.provisioning.stanje, "aktivna");
  assert.match(institucija.provisioning.institutionServerId, /^[0-9a-f-]{36}$/);
  assert.equal(institucija.pokusaji.ukupno, 2);
  assert.equal(institucija.pokusaji.zadnjaGreska, null);
  assert.ok(institucija.pokusaji.zadnji);
  assert.equal(lazni.zahtjevi.length, 2);

  const opet = await ponovi(id);
  assert.equal(opet.status, 409);
  assert.deepEqual(await opet.json(), { error: "stanje_konacno", stanje: "aktivna" });
  assert.equal(lazni.zahtjevi.length, 2, "aktivna: Institution_server is not called again");
});

// Brings a fresh institution into greska through the route.
async function uGresku(fakultetId, aaiDomena) {
  const { id } = await stvori(fakultetId, aaiDomena);
  lazni.odgovor = () => ({ status: 409, body: { greska: "slug_zauzet" } });
  const res = await ponovi(id);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).institucija.provisioning.stanje, "greska");
  return id;
}

test("ponovi on a request still zatrazena raises it", async () => {
  const a = await stvori("fpzg", "fpzg.example.hr");
  assert.equal((await ponovi(a.id)).status, 200);
  assert.equal(lazni.zahtjevi.length, 1);
});

test("ponovi on greska sends the request again and turns it aktivna (DAN-1532)", async () => {
  const id = await uGresku("fpzg", "fpzg.example.hr");
  lazni.vratiZadano();
  const res = await ponovi(id);
  assert.equal(res.status, 200);
  const { institucija } = await res.json();
  assert.equal(institucija.provisioning.stanje, "aktivna");
  assert.equal(institucija.provisioning.kodGreske, null);
  assert.equal(institucija.provisioning.zadnjaGreska, null);
  assert.match(institucija.provisioning.institutionServerId, /^[0-9a-f-]{36}$/);
  assert.equal(institucija.pokusaji.ukupno, 2);
  assert.equal(lazni.zahtjevi.length, 2);
  assert.deepEqual(lazni.zahtjevi[1].tijelo, lazni.zahtjevi[0].tijelo, "the same frozen payload");

  const opet = await ponovi(id);
  assert.equal(opet.status, 409);
  assert.deepEqual(await opet.json(), { error: "stanje_konacno", stanje: "aktivna" });
  assert.equal(lazni.zahtjevi.length, 2);
});

test("ponovi on greska that fails again stays greska with the new code; a run still skips it", async () => {
  const id = await uGresku("fpzg", "fpzg.example.hr");
  lazni.odgovor = () => ({ status: 409, body: { greska: "domena_zauzeta" } });
  const res = await ponovi(id);
  assert.equal(res.status, 200);
  const { institucija } = await res.json();
  assert.equal(institucija.provisioning.stanje, "greska");
  assert.equal(institucija.provisioning.kodGreske, "domena_zauzeta");
  assert.match(institucija.provisioning.zadnjaGreska, /409 domena_zauzeta/);
  assert.equal(institucija.pokusaji.ukupno, 2);
  assert.equal(lazni.zahtjevi.length, 2);
  // `pnpm instance:podigni` never retries greska on its own.
  assert.deepEqual(await podigniInstance({ pool, klijent: klijent() }), []);
  assert.equal(lazni.zahtjevi.length, 2);

  // A server error on the retry leaves it u_izradi, so the next run picks it up.
  lazni.odgovor = () => ({ status: 503, body: {} });
  const treci = await ponovi(id);
  assert.equal(treci.status, 200);
  const p = (await treci.json()).institucija.provisioning;
  assert.equal(p.stanje, "u_izradi");
  assert.equal(p.kodGreske, null);
  assert.equal(lazni.zahtjevi.length, 3);
});

test("two simultaneous ponovi calls on greska make exactly one attempt", async () => {
  const id = await uGresku("fpzg", "fpzg.example.hr");
  lazni.vratiZadano();
  const [x, y] = await Promise.all([ponovi(id), ponovi(id)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(lazni.zahtjevi.length, 2, "one call for the greska, one for the retry");
  const { institucija } = await (await get(id)).json();
  assert.equal(institucija.pokusaji.ukupno, 2);
  assert.equal(institucija.provisioning.stanje, "aktivna");
});

test("a retry from a view that is already out of date makes no attempt, even back in greska", async () => {
  const id = await uGresku("fpzg", "fpzg.example.hr");
  // The first retry fails again: greska with attempts 2.
  assert.equal((await ponovi(id)).status, 200);
  assert.equal(lazni.zahtjevi.length, 2);
  // A second retry sent from the view of attempt 1 arrives after it.
  const [r] = await podigniInstance({ pool, klijent: klijent(), institutionId: id, ponoviGresku: true, pokusaja: 1 });
  assert.equal(r.stanje, null);
  assert.equal(lazni.zahtjevi.length, 2);
  assert.equal((await (await get(id)).json()).institucija.pokusaji.ukupno, 2);
});

test("a run over all requests, or for one without ponoviGresku, does not take it out of greska", async () => {
  const id = await uGresku("fpzg", "fpzg.example.hr");
  lazni.vratiZadano();
  assert.deepEqual(await podigniInstance({ pool, klijent: klijent(), ponoviGresku: true }), []);
  assert.deepEqual(await podigniInstance({ pool, klijent: klijent(), institutionId: id }), []);
  assert.equal(lazni.zahtjevi.length, 1);
});

test("two simultaneous ponovi calls make exactly one attempt", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const [x, y] = await Promise.all([ponovi(id), ponovi(id)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(lazni.zahtjevi.length, 1);
  const { institucija } = await (await get(id)).json();
  assert.equal(institucija.pokusaji.ukupno, 1);
  assert.equal(institucija.provisioning.stanje, "aktivna");
});

test("ponovi while another run holds the request is 409 u_toku and makes no attempt", async () => {
  const { id } = await stvori("fpzg", "fpzg.example.hr");
  const holder = await pool.connect();
  try {
    await holder.query("SELECT pg_advisory_lock(110902, hashtext($1::text))", [id]);
    const res = await ponovi(id);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "u_toku", stanje: "zatrazena" });
    assert.equal(lazni.zahtjevi.length, 0);
    assert.equal((await (await get(id)).json()).institucija.pokusaji.ukupno, 0);
  } finally {
    await holder.query("SELECT pg_advisory_unlock(110902, hashtext($1::text))", [id]);
    holder.release();
  }
});
