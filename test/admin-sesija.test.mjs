// lib/admin-sesija.js and admin/lozinka.js without a database: the signed
// token, the cookie, the guard adminIzZahtjeva and argon2id hashes.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "node:test";

import { hashirajLozinku, lazniHash, PARAMETRI, provjeriLozinku } from "../admin/lozinka.js";
import {
  adminIzZahtjeva,
  izdajToken,
  KOLACIC,
  kolacicOdjave,
  kolacicPrijave,
  provjeriToken,
  tajna,
  tokenIzKolacica,
  TRAJANJE_S,
} from "../lib/admin-sesija.js";

const SECRET = "s".repeat(40);
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["DUCTURA_ADMIN_TOKEN_SECRET", "NODE_ENV"]) {
    if (k in saved) process.env[k] = saved[k];
    else delete process.env[k];
  }
});
const sTajnom = () => (process.env.DUCTURA_ADMIN_TOKEN_SECRET = SECRET);
const zahtjev = (cookie) => new Request("http://localhost/api/admin/ja", { headers: cookie ? { cookie } : {} });

test("secret: missing or shorter than 32 characters means no admin at all", () => {
  delete process.env.DUCTURA_ADMIN_TOKEN_SECRET;
  assert.equal(tajna(), null);
  assert.throws(() => izdajToken("ana"), /DUCTURA_ADMIN_TOKEN_SECRET/);
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "x".repeat(31);
  assert.equal(tajna(), null);
  sTajnom();
  const token = izdajToken("ana", NOW);
  delete process.env.DUCTURA_ADMIN_TOKEN_SECRET;
  assert.equal(provjeriToken(token, NOW), null);
});

test("token: round trip, 8 h lifetime, expiry and clock skew", () => {
  sTajnom();
  const token = izdajToken("ana.k", NOW);
  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(provjeriToken(token, NOW), "ana.k");
  assert.equal(provjeriToken(token, NOW + (TRAJANJE_S - 1) * 1000), "ana.k");
  assert.equal(provjeriToken(token, NOW + TRAJANJE_S * 1000), null, "expired at exp");
  assert.equal(provjeriToken(token, NOW - 60_000), "ana.k", "60 s of clock skew is allowed");
  assert.equal(provjeriToken(token, NOW - 61_000), null, "issued in the future");
  assert.equal(TRAJANJE_S, 8 * 3600);
});

test("token: refuses invalid names, tampering, another secret and forged claims", () => {
  sTajnom();
  for (const bad of ["Ana", "an", "a".repeat(41), "ana k", "", null, 5]) assert.throws(() => izdajToken(bad, NOW), TypeError);
  const token = izdajToken("ana", NOW);
  const [v, payload, sig] = token.split(".");
  const flip = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  for (const bad of [
    `${v}.${flip(payload)}.${sig}`,
    `${v}.${payload}.${flip(sig)}`,
    `v2.${payload}.${sig}`,
    `${token}.x`,
    `${v}.${payload}`,
    "",
    "v1..x",
    null,
    undefined,
    42,
  ]) {
    assert.equal(provjeriToken(bad, NOW), null, String(bad));
  }
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "o".repeat(40);
  assert.equal(provjeriToken(token, NOW), null, "another secret");

  // Correctly signed but forged claims are still refused.
  sTajnom();
  const sign = (claims) => {
    const p = Buffer.from(typeof claims === "string" ? claims : JSON.stringify(claims)).toString("base64url");
    const s = createHmac("sha256", SECRET).update(`${KOLACIC}.v1.${p}`).digest("base64url");
    return `v1.${p}.${s}`;
  };
  const iat = Math.floor(NOW / 1000);
  assert.equal(provjeriToken(sign({ sub: "ana", iat, exp: iat + TRAJANJE_S }), NOW), "ana", "the signer is right");
  for (const claims of [
    { sub: "ana", iat, exp: iat + TRAJANJE_S * 100 },
    { sub: "Ana", iat, exp: iat + TRAJANJE_S },
    { sub: ["ana"], iat, exp: iat + TRAJANJE_S },
    { sub: "ana", iat: String(iat), exp: iat + TRAJANJE_S },
    { sub: "ana", iat: iat + 0.5, exp: iat + TRAJANJE_S + 0.5 },
    { sub: "ana", exp: iat + TRAJANJE_S },
    null,
    "not json",
    [1],
  ]) {
    assert.equal(provjeriToken(sign(claims), NOW), null, JSON.stringify(claims));
  }
});

test("cookie: only the ductura_admin value, and none when it is sent twice", () => {
  assert.equal(tokenIzKolacica(undefined), null);
  assert.equal(tokenIzKolacica(""), null);
  assert.equal(tokenIzKolacica("a=1; ductura_admin=xyz; b=2"), "xyz");
  assert.equal(tokenIzKolacica("ductura_admin_x=1; x_ductura_admin=2"), null);
  assert.equal(tokenIzKolacica("ductura_admin=a; ductura_admin=b"), null);
});

test("adminIzZahtjeva: the admin of a valid cookie, null otherwise", () => {
  sTajnom();
  const token = izdajToken("ana", NOW);
  assert.deepEqual(adminIzZahtjeva(zahtjev(`${KOLACIC}=${token}`), NOW), { korisnickoIme: "ana" });
  assert.equal(adminIzZahtjeva(zahtjev(), NOW), null);
  assert.equal(adminIzZahtjeva(zahtjev(`${KOLACIC}=${token}x`), NOW), null);
  assert.equal(adminIzZahtjeva(zahtjev(`${KOLACIC}=${token}`), NOW + TRAJANJE_S * 1000), null);
  // A bearer header is no session.
  const bearer = new Request("http://localhost/", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(adminIzZahtjeva(bearer, NOW), null);
});

test("cookie attributes: HttpOnly, SameSite=Strict, Path=/, 8 h; Secure only in production", () => {
  process.env.NODE_ENV = "development";
  assert.equal(kolacicPrijave("t"), "ductura_admin=t; Max-Age=28800; HttpOnly; SameSite=Strict; Path=/");
  assert.equal(kolacicOdjave(), "ductura_admin=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/");
  process.env.NODE_ENV = "production";
  assert.equal(kolacicPrijave("t"), "ductura_admin=t; Max-Age=28800; HttpOnly; SameSite=Strict; Path=/; Secure");
  assert.equal(kolacicOdjave(), "ductura_admin=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/; Secure");
});

const BRZO = { memory: 1024, passes: 1, parallelism: 1, tagLength: 32 };

test("argon2id: PHC string with salt, verifies only the same password", async () => {
  const a = await hashirajLozinku("tocna-lozinka-123", BRZO);
  const b = await hashirajLozinku("tocna-lozinka-123", BRZO);
  assert.match(a, /^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.notEqual(a, b, "random salt");
  assert.equal(await provjeriLozinku("tocna-lozinka-123", a), true);
  assert.equal(await provjeriLozinku("tocna-lozinka-124", a), false);
  assert.equal(await provjeriLozinku("", a), false);
  assert.equal(await provjeriLozinku(null, a), false);
  assert.equal(await provjeriLozinku("x".repeat(1025), a), false);
  await assert.rejects(hashirajLozinku(""), TypeError);
  await assert.rejects(hashirajLozinku("x".repeat(1025)), TypeError);
  await assert.rejects(hashirajLozinku(42), TypeError);
});

test("argon2id: the default parameters and the dummy hash", async () => {
  assert.deepEqual({ ...PARAMETRI }, { memory: 65_536, passes: 3, parallelism: 1, tagLength: 32 });
  const lazni = await lazniHash();
  assert.match(lazni, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.equal(await lazniHash(), lazni, "computed once");
});

test("argon2id: malformed hashes and parameters out of bounds are refused without running", async () => {
  const ok = await hashirajLozinku("tocna-lozinka-123", BRZO);
  const [, , , params, sol, kljuc] = ok.split("$");
  const s = (p, so = sol, k = kljuc) => `$argon2id$v=19$${p}$${so}$${k}`;
  assert.equal(await provjeriLozinku("tocna-lozinka-123", s(params)), true);
  for (const bad of [
    null,
    "",
    ok.replace("argon2id", "argon2i"),
    ok.replace("v=19", "v=16"),
    s("m=1024,t=1,p=1", sol, kljuc.slice(0, 10)),
    s("m=1024,t=1,p=1", sol.slice(0, 5)),
    s("m=4194304,t=1,p=1"),
    s("m=1024,t=11,p=1"),
    s("m=1024,t=0,p=1"),
    s("m=1024,t=1,p=9"),
    s("m=4,t=1,p=1"),
    `${ok}x!`,
  ]) {
    assert.equal(await provjeriLozinku("tocna-lozinka-123", bad), false, String(bad));
  }
});
