// institutions/ without a database: the faculty list, input checks that run
// before any query, and the admin gate of /api/admin/institutions.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import * as route from "../app/api/admin/institutions/route.js";
import { FAKULTETI, IZVOR, nadjiFakultet } from "../institutions/fakulteti.js";
import { InstitucijaGreska, stvoriInstituciju } from "../institutions/stvori.js";
import { izdajToken, TRAJANJE_S } from "../lib/admin-sesija.js";

const URL = "http://localhost/api/admin/institutions";
const SECRET = "t".repeat(40);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["DUCTURA_ADMIN_TOKEN_SECRET", "AAI_OIDC_ISSUER", "DATABASE_URL"]) {
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

const call = (method, { cookie, body, type = "application/json" } = {}) => {
  const headers = { "content-type": type };
  if (cookie !== undefined) headers.cookie = cookie;
  return route[method](new Request(URL, { method, headers, body }));
};

// A signed-in platform admin: the ductura_admin cookie of lib/admin-sesija.js.
const prijavljen = (ime = "ana", nowMs = Date.now()) => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = SECRET;
  return `ductura_admin=${izdajToken(ime, nowMs)}`;
};

test("routes are closed (401) without the admin session secret", async () => {
  const cookie = prijavljen();
  for (const secret of [undefined, "short"]) {
    if (secret === undefined) delete process.env.DUCTURA_ADMIN_TOKEN_SECRET;
    else process.env.DUCTURA_ADMIN_TOKEN_SECRET = secret;
    for (const method of ["GET", "POST"]) {
      const res = await call(method, { cookie, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), { error: "nije_prijavljen" });
    }
  }
});

test("routes refuse a missing, forged, expired or bearer admin session with 401", async () => {
  const valid = prijavljen().slice("ductura_admin=".length);
  const expired = prijavljen("ana", Date.now() - TRAJANJE_S * 1000 - 1000).slice("ductura_admin=".length);
  for (const cookie of [
    undefined,
    "",
    `ductura_admin=${valid}x`,
    `ductura_admin=${expired}`,
    `ductura_admin=${valid}; ductura_admin=${valid}`,
    `other=${valid}`,
  ]) {
    for (const method of ["GET", "POST"]) {
      const res = await call(method, { cookie, body: method === "POST" ? JSON.stringify(OK) : undefined });
      assert.equal(res.status, 401, `${method} ${cookie}`);
      assert.deepEqual(await res.json(), { error: "nije_prijavljen" });
    }
  }
  // The old operator bearer key is no way in any more.
  const res = await route.GET(new Request(URL, { headers: { authorization: `Bearer ${valid}` } }));
  assert.equal(res.status, 401);
  // Signed with another secret.
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "o".repeat(40);
  assert.equal((await call("GET", { cookie: `ductura_admin=${valid}` })).status, 401);
});

test("POST checks content type, size and JSON before creating anything", async () => {
  const cookie = prijavljen();
  delete process.env.DATABASE_URL;
  assert.equal((await call("POST", { cookie, body: "{}", type: "text/plain" })).status, 415);
  assert.equal((await call("POST", { cookie, body: JSON.stringify({ x: "a".repeat(17_000) }) })).status, 413);
  assert.deepEqual(await (await call("POST", { cookie, body: "{" })).json(), { error: "neispravan_json" });
  for (const body of ["null", "[]", "5"]) assert.equal((await call("POST", { cookie, body })).status, 400);
  const res = await call("POST", { cookie, body: JSON.stringify({ ...OK, fakultetId: "nema" }) });
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
