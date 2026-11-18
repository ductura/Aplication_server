// POST /api/admin/prijava, POST /api/admin/odjava and GET /api/admin/ja
// without a database: the user store is a stub, the hashes are real argon2id.
import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

import { hashirajLozinku, provjeriLozinku } from "../admin/lozinka.js";
import { OgranicenjePokusaja } from "../admin/ogranicenje.js";
import { ipIzZahtjeva, napraviPrijavu, normalizirajIme } from "../admin/prijava.js";
import * as jaRoute from "../app/api/admin/ja/route.js";
import * as odjavaRoute from "../app/api/admin/odjava/route.js";
import * as prijavaRoute from "../app/api/admin/prijava/route.js";
import { izdajToken, provjeriToken, TRAJANJE_S } from "../lib/admin-sesija.js";

const URL = "http://localhost/api/admin/prijava";
const LOZINKA = "Dugacka-lozinka-za-test-1";
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
let hashAne;

before(async () => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "p".repeat(48);
  delete process.env.NODE_ENV;
  hashAne = await hashirajLozinku(LOZINKA, { memory: 1024, passes: 1, parallelism: 1, tagLength: 32 });
});

let ogranicenje;
let sad;
let pozivi;
beforeEach(() => {
  ogranicenje = new OgranicenjePokusaja();
  sad = NOW;
  pozivi = { nadji: [], provjeri: 0 };
});

const prijava = () =>
  napraviPrijavu({
    nadjiHash: async (ime) => {
      pozivi.nadji.push(ime);
      return ime === "ana" ? hashAne : null;
    },
    provjeri: async (lozinka, hash) => {
      pozivi.provjeri += 1;
      return provjeriLozinku(lozinka, hash);
    },
    ogranicenje,
    sad: () => sad,
  });

const posalji = (body, { ip = "10.0.0.1", headers = {}, raw = false } = {}) =>
  prijava()(
    new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
      body: raw ? body : JSON.stringify(body),
    }),
  );

async function neuspjesna(res) {
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.deepEqual(await res.json(), { greska: "prijava_neuspjesna" });
}

test("success: 200 with the normalised name and a signed 8 h ductura_admin cookie", async () => {
  const res = await posalji({ korisnickoIme: "  AnA ", lozinka: LOZINKA });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { korisnickoIme: "ana" });
  const cookie = res.headers.get("set-cookie");
  const m = /^ductura_admin=([^;]+); Max-Age=28800; HttpOnly; SameSite=Strict; Path=\/$/.exec(cookie);
  assert.ok(m, cookie);
  assert.equal(provjeriToken(m[1], NOW), "ana");
  assert.equal(provjeriToken(m[1], NOW + TRAJANJE_S * 1000), null);
  assert.deepEqual(pozivi.nadji, ["ana"]);
});

test("wrong password and unknown name: the same 401, and the hash is checked either way", async () => {
  await neuspjesna(await posalji({ korisnickoIme: "ana", lozinka: `${LOZINKA}x` }));
  assert.equal(pozivi.provjeri, 1);
  await neuspjesna(await posalji({ korisnickoIme: "nepostojeci", lozinka: LOZINKA }));
  assert.equal(pozivi.provjeri, 2, "unknown name still runs argon2id (dummy hash)");
  assert.deepEqual(pozivi.nadji, ["ana", "nepostojeci"]);
});

test("unknown, missing or wrongly typed fields: 401 prijava_neuspjesna without a lookup", async () => {
  for (const body of [
    { korisnickoIme: "ana", lozinka: LOZINKA, uloga: "admin" },
    { korisnickoIme: "ana", lozinka: LOZINKA, __proto__: { x: 1 }, constructor: 1 },
    { korisnickoIme: "ana" },
    { lozinka: LOZINKA },
    {},
    { korisnickoIme: ["ana"], lozinka: LOZINKA },
    { korisnickoIme: "ana", lozinka: 123456789012 },
    { korisnickoIme: "ana", lozinka: "" },
    { korisnickoIme: "ana", lozinka: "x".repeat(1025) },
    { korisnickoIme: "a", lozinka: LOZINKA },
    { korisnickoIme: "ana k", lozinka: LOZINKA },
    { korisnickoIme: "ana@x", lozinka: LOZINKA },
    [],
    ["ana", LOZINKA],
    null,
    "ana",
    7,
  ]) {
    ogranicenje = new OgranicenjePokusaja();
    const before = pozivi.provjeri;
    await neuspjesna(await posalji(body));
    assert.equal(pozivi.provjeri, before + 1, `${JSON.stringify(body)}: dummy hash still checked`);
  }
  assert.deepEqual(pozivi.nadji, [], "no lookup for a malformed body");
});

test("only JSON, at most 4 KB, valid UTF-8", async () => {
  const bez = (headers) => prijava()(new Request(URL, { method: "POST", headers, body: "{}" }));
  for (const ct of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/jsonx", "multipart/form-data"]) {
    const res = await bez(ct ? { "content-type": ct } : {});
    assert.equal(res.status, 415, String(ct));
    assert.deepEqual(await res.json(), { greska: "ocekuje_se_json" });
  }
  const ok = await posalji({ korisnickoIme: "ana", lozinka: LOZINKA }, { headers: { "content-type": "Application/JSON; charset=utf-8" } });
  assert.equal(ok.status, 200);

  const velik = JSON.stringify({ korisnickoIme: "ana", lozinka: "x".repeat(4200) });
  let res = await posalji(velik, { raw: true });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { greska: "prevelik_zahtjev" });
  // A false Content-Length does not get a larger body through.
  res = await posalji(velik, { raw: true, headers: { "content-length": "10" } });
  assert.equal(res.status, 413);
  res = await posalji("{}", { raw: true, headers: { "content-length": "99999999999" } });
  assert.equal(res.status, 413);
  // A streamed body without Content-Length is counted too.
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 10; i += 1) c.enqueue(new TextEncoder().encode("x".repeat(500)));
      c.close();
    },
  });
  res = await prijava()(
    new Request(URL, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }),
  );
  assert.equal(res.status, 413);
  // Exactly 4 KB is still read.
  const tocno = JSON.stringify({ korisnickoIme: "ana", lozinka: "y".repeat(4096 - 36) });
  assert.equal(Buffer.byteLength(tocno), 4096);
  await neuspjesna(await posalji(tocno, { raw: true }));

  for (const bad of ["{", "", "nije json", new Uint8Array([0x7b, 0xff, 0x7d])]) {
    res = await posalji(bad, { raw: true });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { greska: "neispravan_json" });
  }
  assert.deepEqual(pozivi.nadji, ["ana"]);
});

test("without DUCTURA_ADMIN_TOKEN_SECRET login is 503 and nothing is checked", async () => {
  const secret = process.env.DUCTURA_ADMIN_TOKEN_SECRET;
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "short";
  try {
    const res = await posalji({ korisnickoIme: "ana", lozinka: LOZINKA });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { greska: "prijava_nije_dostupna" });
    assert.equal(pozivi.provjeri, 0);
  } finally {
    process.env.DUCTURA_ADMIN_TOKEN_SECRET = secret;
  }
});

test("rate limit per name: 5 failures in 15 min, then 429 with Retry-After, even with the right password", async () => {
  for (let i = 0; i < 5; i += 1) {
    await neuspjesna(await posalji({ korisnickoIme: "ana", lozinka: "kriva" }, { ip: `10.0.1.${i}` }));
  }
  sad = NOW + 60_000;
  let res = await posalji({ korisnickoIme: " ANA", lozinka: LOZINKA }, { ip: "10.0.2.1" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), String(14 * 60));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { greska: "previse_pokusaja" });
  assert.equal(pozivi.provjeri, 5, "a limited attempt checks no password");
  // Another name from a fresh IP is not limited.
  res = await posalji({ korisnickoIme: "ivo", lozinka: "kriva" }, { ip: "10.0.2.2" });
  assert.equal(res.status, 401);
  // The window slides: after 15 min from the first failure, ana may try again.
  sad = NOW + 15 * 60_000 + 1;
  res = await posalji({ korisnickoIme: "ana", lozinka: LOZINKA }, { ip: "10.0.2.3" });
  assert.equal(res.status, 200);
});

test("rate limit per IP: 5 attempts over any names, then 429", async () => {
  for (const ime of ["a01", "a02", "a03", "a04"]) {
    await neuspjesna(await posalji({ korisnickoIme: ime, lozinka: "kriva" }, { ip: "203.0.113.9" }));
  }
  await neuspjesna(await posalji({ nepoznato: 1 }, { ip: "203.0.113.9" }));
  const res = await posalji({ korisnickoIme: "ana", lozinka: LOZINKA }, { ip: "203.0.113.9" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), String(15 * 60));
  // The IP is the last X-Forwarded-For entry, the one the nearest proxy added.
  const res2 = await posalji({ korisnickoIme: "ana", lozinka: LOZINKA }, { ip: "203.0.113.9, 198.51.100.4" });
  assert.equal(res2.status, 200);
});

test("parallel attempts cannot pass the limit together; success gives its attempt back", async () => {
  const svi = await Promise.all(
    Array.from({ length: 12 }, () => posalji({ korisnickoIme: "ana", lozinka: "kriva" }, { ip: "10.9.9.9" })),
  );
  assert.deepEqual(svi.map((r) => r.status).sort(), [...Array(5).fill(401), ...Array(7).fill(429)]);

  ogranicenje = new OgranicenjePokusaja();
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await posalji({ korisnickoIme: "ana", lozinka: LOZINKA }, { ip: "10.9.9.8" })).status, 200);
  }
});

test("limiter: bounded number of keys, retry-after at least 1 s", () => {
  const o = new OgranicenjePokusaja({ najvise: 1, prozorMs: 1000, najviseKljuceva: 3 });
  for (const k of ["a", "b", "c", "d", "e"]) assert.equal(o.zauzmi([k], 0).dopusteno, true);
  assert.ok(o.velicina <= 3, String(o.velicina));
  const z = o.zauzmi(["e"], 999);
  assert.deepEqual(z, { dopusteno: false, retryAfterS: 1 });
  assert.equal(o.zauzmi(["e"], 1000).dopusteno, true);
  const p = o.zauzmi(["x", "y"], 5000);
  p.otpusti();
  p.otpusti();
  assert.equal(o.zauzmi(["x"], 5000).dopusteno, true);
});

test("name normalisation and the client IP", () => {
  assert.equal(normalizirajIme("  Ana.K_1-x "), "ana.k_1-x");
  for (const bad of ["ab", " ab ", "a".repeat(41), "ana k", "ánа", "an\na", null, 5, "x".repeat(300)]) {
    assert.equal(normalizirajIme(bad), null, String(bad));
  }
  const ip = (xff) => ipIzZahtjeva(new Request(URL, { headers: xff === undefined ? {} : { "x-forwarded-for": xff } }));
  assert.equal(ip(undefined), "nepoznata");
  assert.equal(ip(""), "nepoznata");
  assert.equal(ip("1.1.1.1, 2.2.2.2 "), "2.2.2.2");
  assert.equal(ip("x".repeat(65)), "nepoznata");
});

test("GET /api/admin/ja: the admin of the cookie, else 401", async () => {
  const token = izdajToken("ana");
  let res = jaRoute.GET(new Request("http://localhost/api/admin/ja", { headers: { cookie: `ductura_admin=${token}` } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { korisnickoIme: "ana" });
  for (const cookie of [undefined, "ductura_admin=", `ductura_admin=${token}x`, `other=${token}`]) {
    res = jaRoute.GET(new Request("http://localhost/api/admin/ja", { headers: cookie ? { cookie } : {} }));
    assert.equal(res.status, 401, String(cookie));
    assert.deepEqual(await res.json(), { greska: "nije_prijavljen" });
  }
});

test("POST /api/admin/odjava: 204 and the cookie is cleared", async () => {
  const res = odjavaRoute.POST(new Request("http://localhost/api/admin/odjava", { method: "POST" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("set-cookie"), "ductura_admin=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("routes: other methods are 405 with Allow, OPTIONS is 204", async () => {
  for (const [route, allow, wrong] of [
    [prijavaRoute, "POST, OPTIONS", ["GET", "PUT", "PATCH", "DELETE"]],
    [odjavaRoute, "POST, OPTIONS", ["GET", "PUT", "PATCH", "DELETE"]],
    [jaRoute, "GET, HEAD, OPTIONS", ["POST", "PUT", "PATCH", "DELETE"]],
  ]) {
    for (const m of wrong) {
      const res = route[m]();
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), allow);
    }
    const res = route.OPTIONS();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("allow"), allow);
  }
  // The real route refuses before touching the database.
  const res = await prijavaRoute.POST(new Request(URL, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }));
  assert.equal(res.status, 415);
});
