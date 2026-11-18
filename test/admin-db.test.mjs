// admin/ against a real PostgreSQL (`pnpm test:db`): the platform_admin
// migration, `pnpm admin:stvori` and a login through the real route. Like the
// institutions suite it needs DATABASE_URL on a database whose name contains
// "test", drops and recreates the admin schema there, and never skips.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { migracije, primijeniMigracije } from "../admin/migrate.js";
import { AdminGreska, stvoriAdmina } from "../admin/stvori.js";
import * as jaRoute from "../app/api/admin/ja/route.js";
import * as prijavaRoute from "../app/api/admin/prijava/route.js";

const DATABASE_URL = process.env.DATABASE_URL;
const STVORI = fileURLToPath(new URL("../admin/stvori.js", import.meta.url));
const LOZINKA = "Sinteticka-lozinka-42!";
let pool;

before(async () => {
  assert.ok(DATABASE_URL, "DATABASE_URL must be set for pnpm test:db");
  assert.match(new globalThis.URL(DATABASE_URL).pathname, /test/, "DATABASE_URL must name a test database");
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "d".repeat(40);
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  await pool.query("DROP SCHEMA IF EXISTS admin CASCADE; DROP TABLE IF EXISTS public.admin_migration");
  assert.deepEqual(await primijeniMigracije(pool), migracije().map((m) => m.name));
});

after(async () => {
  await pool?.end();
  const { dohvatiPool } = await import("../institutions/db.js");
  await dohvatiPool().end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE admin.platform_admin");
});

const hashOf = async (ime) =>
  (await pool.query("SELECT lozinka_hash FROM admin.platform_admin WHERE korisnicko_ime = $1", [ime])).rows[0]?.lozinka_hash;

test("migrations are recorded and a second run applies nothing", async () => {
  assert.deepEqual(await primijeniMigracije(pool), []);
  const { rows } = await pool.query("SELECT name FROM public.admin_migration ORDER BY name");
  assert.deepEqual(rows.map((r) => r.name), ["0001_platform_admin.sql"]);
});

test("platform_admin: CHECKs refuse unnormalised names and anything but an argon2id hash", async () => {
  const { korisnickoIme } = await stvoriAdmina({ korisnickoIme: "ana", lozinka: LOZINKA }, { pool });
  const hash = await hashOf(korisnickoIme);
  for (const ime of ["Ana", " ana", "an", "a".repeat(41), "ana k", "ana@x"]) {
    await assert.rejects(
      pool.query("INSERT INTO admin.platform_admin (korisnicko_ime, lozinka_hash) VALUES ($1, $2)", [ime, hash]),
      (err) => err.code === "23514",
      ime,
    );
  }
  for (const bad of ["lozinka", "", hash.replace("argon2id", "argon2i"), `${hash}$`, hash.replace(/\$[^$]+$/, "$x")]) {
    await assert.rejects(
      pool.query("INSERT INTO admin.platform_admin (korisnicko_ime, lozinka_hash) VALUES ('ivo', $1)", [bad]),
      (err) => err.code === "23514",
      bad,
    );
  }
  await assert.rejects(
    pool.query("INSERT INTO admin.platform_admin (korisnicko_ime, lozinka_hash) VALUES ('ana', $1)", [hash]),
    (err) => err.code === "23505",
  );
});

test("stvoriAdmina: normalises, refuses short passwords and duplicates, --zamijeni sets a new hash", async () => {
  assert.deepEqual(await stvoriAdmina({ korisnickoIme: " Ana.K ", lozinka: LOZINKA }, { pool }), { korisnickoIme: "ana.k", novo: true });
  const prvi = await hashOf("ana.k");
  assert.match(prvi, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!prvi.includes(LOZINKA));
  const greska = (kod) => (err) => err instanceof AdminGreska && err.kod === kod;
  await assert.rejects(stvoriAdmina({ korisnickoIme: "ana.k", lozinka: LOZINKA }, { pool }), greska("vec_postoji"));
  await assert.rejects(stvoriAdmina({ korisnickoIme: "ivo", lozinka: "kratka-1234" }, { pool }), greska("prekratka_lozinka"));
  // 12 characters, counted as characters, not bytes.
  await assert.rejects(stvoriAdmina({ korisnickoIme: "ivo", lozinka: "šđčćž123456" }, { pool }), greska("prekratka_lozinka"));
  assert.equal((await stvoriAdmina({ korisnickoIme: "ivo", lozinka: "šđčćž1234567" }, { pool })).novo, true);
  await assert.rejects(stvoriAdmina({ korisnickoIme: "i", lozinka: LOZINKA }, { pool }), greska("neispravno_ime"));
  await assert.rejects(stvoriAdmina({ korisnickoIme: "ivo2", lozinka: "x".repeat(1025) }, { pool }), greska("preduga_lozinka"));
  assert.deepEqual(
    await stvoriAdmina({ korisnickoIme: "ana.k", lozinka: `${LOZINKA}-nova`, zamijeni: true }, { pool }),
    { korisnickoIme: "ana.k", novo: false },
  );
  assert.notEqual(await hashOf("ana.k"), prvi);
});

const prijavi = (body, ip) =>
  prijavaRoute.POST(
    new Request("http://localhost/api/admin/prijava", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );

test("login through the real route and database, then /api/admin/ja with the cookie", async () => {
  await stvoriAdmina({ korisnickoIme: "ana", lozinka: LOZINKA }, { pool });
  let res = await prijavi({ korisnickoIme: "ana", lozinka: "kriva-lozinka-1" }, "192.0.2.1");
  assert.equal(res.status, 401);
  res = await prijavi({ korisnickoIme: "nema", lozinka: LOZINKA }, "192.0.2.2");
  assert.equal(res.status, 401);
  res = await prijavi({ korisnickoIme: "ANA", lozinka: LOZINKA }, "192.0.2.3");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { korisnickoIme: "ana" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  res = jaRoute.GET(new Request("http://localhost/api/admin/ja", { headers: { cookie } }));
  assert.deepEqual(await res.json(), { korisnickoIme: "ana" });
});

const izlazi = [];
function cli(args, stdin) {
  return new Promise((resolve) => {
    const dijelovi = Array.isArray(stdin) ? stdin : [stdin];
    const child = spawn(process.execPath, [STVORI, ...args], { env: { ...process.env, DATABASE_URL }, stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      izlazi.push(out);
      resolve({ code, out });
    });
    // Chunks are written apart in time, so the child reads them separately.
    (async () => {
      for (const [i, dio] of dijelovi.entries()) {
        if (i > 0) await new Promise((r) => setTimeout(r, 50));
        child.stdin.write(dio);
      }
      child.stdin.end();
    })();
  });
}

test("pnpm admin:stvori: password from stdin only, never printed", async () => {
  let r = await cli(["Ivo.Admin"], `${LOZINKA}\nignored second line\n`);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), "admin ivo.admin je stvoren");
  assert.ok(await hashOf("ivo.admin"));

  r = await cli(["ivo.admin"], `${LOZINKA}\n`);
  assert.equal(r.code, 1);
  assert.match(r.out, /već postoji/);

  r = await cli(["ivo.admin", "--zamijeni"], `${LOZINKA}-druga\r\n`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ima novu lozinku/);
  const res = await prijavi({ korisnickoIme: "ivo.admin", lozinka: `${LOZINKA}-druga` }, "192.0.2.9");
  assert.equal(res.status, 200, "\\r\\n is not part of the password");

  r = await cli(["novi"], "kratka\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /najmanje 12 znakova/);

  // A second argument (a password typed on the command line) is refused.
  r = await cli(["novi", LOZINKA], "");
  assert.equal(r.code, 2);
  assert.match(r.out, /upotreba/);
  r = await cli([], "");
  assert.equal(r.code, 2);
  r = await cli(["x"], `${LOZINKA}\n`);
  assert.equal(r.code, 1);

  // A UTF-8 character split across two stdin chunks is decoded whole.
  const bajtovi = Buffer.from("Sinteticka-š-lozinka\n", "utf8");
  const sredina = bajtovi.indexOf(Buffer.from("š")) + 1;
  r = await cli(["utf.admin"], [bajtovi.subarray(0, sredina), bajtovi.subarray(sredina)]);
  assert.equal(r.code, 0, r.out);
  const ok = await prijavi({ korisnickoIme: "utf.admin", lozinka: "Sinteticka-š-lozinka" }, "192.0.2.10");
  assert.equal(ok.status, 200);

  assert.equal(izlazi.length, 8);
  for (const out of izlazi) assert.ok(!out.includes("Sinteticka"), out);
  const { rows } = await pool.query("SELECT korisnicko_ime FROM admin.platform_admin ORDER BY 1");
  assert.deepEqual(rows.map((x) => x.korisnicko_ime), ["ivo.admin", "utf.admin"]);
});
