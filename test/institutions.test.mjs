// institutions/ without a database: the faculty list, input checks that run
// before any query, and the admin gate of /api/admin/institutions.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as route from "../app/api/admin/institutions/route.js";
import { FAKULTETI, IZVOR, nadjiFakultet } from "../institutions/fakulteti.js";
import { InstitucijaGreska, stvoriInstituciju } from "../institutions/stvori.js";

const URL = "http://localhost/api/admin/institutions";
const TOKEN = "t".repeat(40);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["INSTITUTIONS_ADMIN_TOKEN", "AAI_OIDC_ISSUER", "DATABASE_URL"]) {
    if (k in saved) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

test("faculty list is the unizg.hr list: 32 faculties, unique slug-shaped ids", () => {
  assert.equal(IZVOR, "https://www.unizg.hr/o-sveucilistu/sastavnice-sveucilista/fakulteti/");
  assert.equal(FAKULTETI.length, 32);
  const ids = FAKULTETI.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const f of FAKULTETI) {
    assert.match(f.id, /^[a-z0-9-]{2,32}$/);
    assert.match(f.naziv, /akultet/);
    assert.ok(f.web === null || /^https?:\/\/www\.[a-z0-9.-]+\.hr$/.test(f.web), f.web);
  }
  assert.equal(nadjiFakultet("fpzg").naziv, "Fakultet političkih znanosti");
  assert.equal(nadjiFakultet("fer").naziv, "Fakultet elektrotehnike i računarstva");
  for (const bad of ["nema", "", null, 5, "toString", "__proto__"]) assert.equal(nadjiFakultet(bad), null);
});

const ISSUER = "https://login.aai.example.hr/oidc";
const OK = { fakultetId: "fpzg", aaiDomena: "fpzg.example.hr", issuer: ISSUER, racuni: { institution_admin: 1 } };

async function refused(ulaz, kod, poruka) {
  delete process.env.DATABASE_URL;
  await assert.rejects(stvoriInstituciju(ulaz), (err) => {
    assert.ok(err instanceof InstitucijaGreska, err.message);
    assert.equal(err.kod, kod);
    if (poruka) assert.match(err.message, poruka);
    return true;
  });
}

test("input is checked before the database is touched", async () => {
  await refused(null, "neispravan_unos");
  await refused({ ...OK, fakultetId: "nema" }, "nepoznat_fakultet");
  await refused({ ...OK, fakultetId: "FPZG" }, "nepoznat_fakultet");
  for (const d of ["", "fpzg", "-a.hr", "a-.hr", "a..hr", "a.hr.", "a_b.hr", "fpzg.hr/x", "ä.hr", 5, null, `${"a".repeat(251)}.hr`]) {
    await refused({ ...OK, aaiDomena: d }, "neispravan_unos", /aaiDomena/);
  }
  for (const i of [undefined, "", "login.example.hr", "ftp://x.hr", "https://a b.hr", `https://${"a".repeat(250)}.hr`]) {
    delete process.env.AAI_OIDC_ISSUER;
    await refused({ ...OK, issuer: i }, "neispravan_unos", /issuer/);
  }
  for (const r of [null, [], 5, "x"]) await refused({ ...OK, racuni: r }, "neispravan_unos", /racuni/);
  await refused({ ...OK, racuni: {} }, "neispravan_unos", /institution_admin/);
  await refused({ ...OK, racuni: { institution_admin: 0 } }, "neispravan_unos", /institution_admin/);
  await refused({ ...OK, racuni: { institution_admin: 21 } }, "neispravan_unos", /institution_admin/);
  for (const n of [-1, 1.5, "200", null, Number.NaN, 50_001]) {
    await refused({ ...OK, racuni: { institution_admin: 1, student: n } }, "neispravan_unos", /student/);
  }
  await refused({ ...OK, racuni: { institution_admin: 1, app_admin: 1 } }, "neispravan_unos", /države/);
  await refused({ ...OK, racuni: { institution_admin: 1, admin: 1 } }, "neispravan_unos", /nepoznata uloga/);
  await refused({ ...OK, racuni: JSON.parse('{"institution_admin":1,"__proto__":1}') }, "neispravan_unos", /nepoznata/);
});

test("a valid request without DATABASE_URL fails on the missing database, not on input", async () => {
  delete process.env.DATABASE_URL;
  await assert.rejects(stvoriInstituciju({ ...OK, aaiDomena: " FPZG.Example.HR\n" }), /DATABASE_URL is not set/);
  process.env.AAI_OIDC_ISSUER = ISSUER;
  await assert.rejects(stvoriInstituciju({ ...OK, issuer: undefined }), /DATABASE_URL is not set/);
});

const call = (method, { auth, body, type = "application/json" } = {}) => {
  const headers = { "content-type": type };
  if (auth !== undefined) headers.authorization = auth;
  return route[method](new Request(URL, { method, headers, body }));
};

test("routes are closed (503) while no admin token is configured", async () => {
  delete process.env.INSTITUTIONS_ADMIN_TOKEN;
  for (const method of ["GET", "POST"]) {
    const res = await call(method, { auth: `Bearer ${TOKEN}`, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "admin_nije_dostupan" });
  }
  process.env.INSTITUTIONS_ADMIN_TOKEN = "short";
  assert.equal((await call("GET", { auth: "Bearer short" })).status, 503);
});

test("routes refuse a missing or wrong bearer token with 401", async () => {
  process.env.INSTITUTIONS_ADMIN_TOKEN = TOKEN;
  for (const auth of [undefined, "", TOKEN, `bearer ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Bearer  ${TOKEN}`, `Basic ${TOKEN}`]) {
    for (const method of ["GET", "POST"]) {
      const res = await call(method, { auth, body: method === "POST" ? JSON.stringify(OK) : undefined });
      assert.equal(res.status, 401, `${method} ${auth}`);
      assert.deepEqual(await res.json(), { error: "nije_prijavljen" });
    }
  }
});

test("POST checks content type, size and JSON before creating anything", async () => {
  process.env.INSTITUTIONS_ADMIN_TOKEN = TOKEN;
  delete process.env.DATABASE_URL;
  const auth = `Bearer ${TOKEN}`;
  assert.equal((await call("POST", { auth, body: "{}", type: "text/plain" })).status, 415);
  assert.equal((await call("POST", { auth, body: JSON.stringify({ x: "a".repeat(17_000) }) })).status, 413);
  assert.deepEqual(await (await call("POST", { auth, body: "{" })).json(), { error: "neispravan_json" });
  for (const body of ["null", "[]", "5"]) assert.equal((await call("POST", { auth, body })).status, 400);
  const res = await call("POST", { auth, body: JSON.stringify({ ...OK, fakultetId: "nema" }) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "nepoznat_fakultet");
});

test("other methods are 405 with Allow; OPTIONS is 204", async () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const res = await route[method](new Request(URL, { method }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  }
  const res = route.OPTIONS(new Request(URL, { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
});
