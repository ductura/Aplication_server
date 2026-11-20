import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { primijeniMigracije as migrirajAdmine } from "../../admin/migrate.js";
import { stvoriAdmina } from "../../admin/stvori.js";
import { primijeniMigracije as migrirajUstanove } from "../../institutions/migrate.js";
import { pokreniAplikaciju } from "./int06-aplikacija.mjs";

const SRV = "http://127.0.0.1:4000";
const ISSUER = "http://localhost:8090";
const ADMIN_RUTA = "/api/admin/institutions";

function testnaBaza() {
  const url = URL.parse(process.env.INT06_DATABASE_URL ?? "");
  assert.ok(url && ["postgres:", "postgresql:"].includes(url.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.username && url.port && /^\/ductura_int06_test(?:_[a-z0-9_]+)?$/.test(url.pathname) &&
    !url.search && !url.hash,
  "INT06_DATABASE_URL mora pokazivati na namjensku lokalnu bazu ductura_int06_test (korisnik i port obvezni).");
  return url.href;
}

async function json(url, status, init = {}) {
  const odgovor = await fetch(url, {
    ...init, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  assert.equal(odgovor.status, status, `${init.method ?? "GET"} ${new URL(url).pathname}`);
  const body = await odgovor.json();
  return { body, headers: odgovor.headers };
}

function post(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

test("INT-06: administrator platforme otvara ustanovu, Institution_server potvrđuje spremnost", async (t) => {
  const databaseUrl = testnaBaza();
  const tokenFile = process.env.INT06_PROVISIONING_TOKEN_FILE;
  assert.ok(tokenFile, "Zadaj INT06_PROVISIONING_TOKEN_FILE iz lokalnog stoga INT-01.");
  const token = (await readFile(tokenFile, "utf8")).trim();
  assert.ok(token.length >= 32, "Token provisioninga mora imati najmanje 32 znaka.");

  await json(`${SRV}/api/v1/health`, 200);
  const simulator = await json(`${ISSUER}/.well-known/openid-configuration`, 200);
  assert.equal(simulator.body.issuer, ISSUER, "Issuer mora pripadati lokalnom simulatoru INT-01.");

  const nastavak = randomBytes(6).toString("hex");
  const slug = `int06-${nastavak}`;
  const aaiDomena = `${slug}.example.invalid`;
  const fakultet = { id: slug, naziv: "Izmišljeni fakultet za provjeru otvaranja", web: `https://${aaiDomena}` };
  const racuni = { student: 7, teacher: 3, network_engineer: 2, institution_admin: 1 };
  const ulaz = { fakultetId: slug, aaiDomena, racuni };
  const interna = `${SRV}/internal/v1/institutions/${slug}`;
  const provjeraSpremnosti = { headers: { authorization: `Bearer ${token}` } };
  await json(interna, 404, provjeraSpremnosti);

  const korisnickoIme = `demo-admin-${nastavak}`;
  const lozinka = randomBytes(24).toString("base64url");
  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await migrirajUstanove(pool);
    await migrirajAdmine(pool);
    await stvoriAdmina({ korisnickoIme, lozinka }, { pool });
  } finally {
    await pool.end();
  }

  const app = await pokreniAplikaciju(t, fakultet, {
    DATABASE_URL: databaseUrl,
    DUCTURA_ADMIN_TOKEN_SECRET: randomBytes(32).toString("base64url"),
    DUCTURA_PROVISIONING_TOKEN: token,
    INSTITUTION_SERVER_URL: SRV,
    AAI_OIDC_ISSUER: ISSUER,
  });

  await json(`${app}${ADMIN_RUTA}`, 401, post(ulaz));
  const prijava = await json(`${app}/api/admin/prijava`, 200, post({ korisnickoIme, lozinka }));
  assert.equal(prijava.body.korisnickoIme, korisnickoIme);
  const cookie = prijava.headers.getSetCookie().find((value) => value.startsWith("ductura_admin="));
  assert.ok(cookie, "Prijava mora izdati sesijski kolačić administratora.");
  const sesija = { cookie: cookie.split(";", 1)[0] };

  const katalog = await json(`${app}/api/admin/fakulteti`, 200, { headers: sesija });
  assert.deepEqual(katalog.body.fakulteti, [fakultet]);
  const stvorena = await json(`${app}${ADMIN_RUTA}`, 201, post(ulaz, sesija));
  const { id, provisioning } = stvorena.body.institucija;
  assert.equal(provisioning.stanje, "aktivna");
  assert.ok(provisioning.institutionServerId, "Odgovor mora sadržavati ID instance iz Institution_servera.");
  const institutionId = provisioning.institutionServerId;

  const spremna = await json(interna, 200, provjeraSpremnosti);
  assert.deepEqual(spremna.body, {
    institutionId, slug, displayName: fakultet.naziv, aaiHomeOrg: aaiDomena,
    oidcIssuer: ISSUER, seats: racuni, status: "aktivna",
  });

  const popis = await json(`${app}${ADMIN_RUTA}`, 200, { headers: sesija });
  const spremljena = popis.body.institucije.find((ustanova) => ustanova.slug === slug);
  assert.ok(spremljena, "Otvorena ustanova mora ostati u administratorskom popisu.");
  assert.equal(spremljena.id, id);
  assert.equal(spremljena.provisioning.stanje, "aktivna");
  assert.equal(spremljena.provisioning.institutionServerId, institutionId);
});
