// The HTTP side of the provisioner without a database: configuration, the
// request body of §2 and every answer of a fake Institution_server.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import {
  konfiguracija,
  PodizanjeGreska,
  posaljiInstituciju,
  PUTANJA,
  TIMEOUT_MS,
  tijeloZahtjeva,
} from "../institutions/podigni.js";
import { LAZNI_TOKEN, pokreniLazniInstitutionServer } from "../institutions/test-fixtures/lazni-institution-server.js";

const PAYLOAD = Object.freeze({
  format: "ductura-instance-v1",
  slug: "fpzg",
  display_name: "Fakultet političkih znanosti",
  aai_home_org: "fpzg.example.hr",
  oidc_issuer: "http://localhost:8090",
  settings: { enrollment_attempt_limit: 5, enrollment_attempt_window_seconds: 900 },
  accounts: { student: 200, teacher: 50, institution_admin: 1, network_engineer: 3 },
  first_admin: { account_id: "00000000-0000-4000-8000-000000000001", role: "institution_admin" },
});
const UUID = "3f1c2b8e-7a4d-4e1b-9c2a-5d6e7f8a9b0c";

let lazni;
let klijent;
before(async () => {
  lazni = await pokreniLazniInstitutionServer();
});
after(() => lazni.zatvori());
beforeEach(() => {
  lazni.zahtjevi.length = 0;
  klijent = konfiguracija({ INSTITUTION_SERVER_URL: lazni.url, DUCTURA_PROVISIONING_TOKEN: LAZNI_TOKEN });
});

const odgovori = (status, body) => {
  lazni.odgovor = () => ({ status, body });
};

test("configuration needs an http(s) URL and a token of at least 32 characters", () => {
  const token = "a".repeat(32);
  assert.deepEqual(konfiguracija({ INSTITUTION_SERVER_URL: "http://127.0.0.1:4000", DUCTURA_PROVISIONING_TOKEN: token }), {
    url: `http://127.0.0.1:4000${PUTANJA}`,
    token,
  });
  assert.equal(
    konfiguracija({ INSTITUTION_SERVER_URL: "https://is.example.hr/base/", DUCTURA_PROVISIONING_TOKEN: token }).url,
    "https://is.example.hr/base/internal/v1/institutions",
  );
  for (const url of [undefined, "", "127.0.0.1:4000", "ftp://x.hr", "http://u:p@x.hr", "http://x.hr/?a=1", "http://x.hr/#a"]) {
    assert.throws(() => konfiguracija({ INSTITUTION_SERVER_URL: url, DUCTURA_PROVISIONING_TOKEN: token }), PodizanjeGreska, String(url));
  }
  for (const t of [undefined, "", "a".repeat(31), `${"a".repeat(32)} `, `${"a".repeat(32)}č`]) {
    assert.throws(
      () => konfiguracija({ INSTITUTION_SERVER_URL: "http://127.0.0.1:4000", DUCTURA_PROVISIONING_TOKEN: t }),
      /DUCTURA_PROVISIONING_TOKEN/,
    );
  }
  assert.equal(TIMEOUT_MS, 10_000);
});

test("the body is exactly the §2 fields, seats per role from the request", () => {
  assert.deepEqual(tijeloZahtjeva(PAYLOAD), {
    slug: "fpzg",
    displayName: "Fakultet političkih znanosti",
    aaiHomeOrg: "fpzg.example.hr",
    oidcIssuer: "http://localhost:8090",
    seats: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
  });
  for (const bad of [null, {}, { ...PAYLOAD, format: "x" }, { ...PAYLOAD, accounts: undefined }, { ...PAYLOAD, accounts: { ...PAYLOAD.accounts, teacher: -1 } }]) {
    assert.throws(() => tijeloZahtjeva(bad), /payload/);
  }
});

test("201: aktivna with the institutionId; the request carries the bearer token and the §2 body", async () => {
  odgovori(201, { institutionId: UUID.toUpperCase(), slug: "fpzg", status: "aktivna" });
  assert.deepEqual(await posaljiInstituciju(PAYLOAD, klijent), { ishod: "aktivna", status: 201, institutionId: UUID });
  const [z] = lazni.zahtjevi;
  assert.equal(z.method, "POST");
  assert.equal(z.url, "/internal/v1/institutions");
  assert.equal(z.headers.authorization, `Bearer ${LAZNI_TOKEN}`);
  assert.match(z.headers["content-type"], /^application\/json/);
  assert.deepEqual(z.tijelo, tijeloZahtjeva(PAYLOAD));
});

test("200 (already there with the same data): aktivna", async () => {
  odgovori(200, { institutionId: UUID, slug: "fpzg", status: "aktivna" });
  assert.deepEqual(await posaljiInstituciju(PAYLOAD, klijent), { ishod: "aktivna", status: 200, institutionId: UUID });
});

test("200 or 201 without a valid institutionId for this slug is retried, never aktivna", async () => {
  for (const body of [{}, { institutionId: "x", slug: "fpzg" }, { institutionId: UUID, slug: "fer" }, null]) {
    odgovori(201, body);
    const r = await posaljiInstituciju(PAYLOAD, klijent);
    assert.equal(r.ishod, "ponovi", JSON.stringify(body));
  }
});

test("409: greska with Institution_server's code", async () => {
  for (const kod of ["slug_zauzet", "domena_zauzeta"]) {
    odgovori(409, { greska: kod });
    const r = await posaljiInstituciju(PAYLOAD, klijent);
    assert.equal(r.ishod, "greska");
    assert.equal(r.status, 409);
    assert.equal(r.kod, kod);
  }
  odgovori(409, { greska: "Nije kod!" });
  assert.equal((await posaljiInstituciju(PAYLOAD, klijent)).kod, "sukob");
});

test("400: greska neispravan_unos with the field", async () => {
  odgovori(400, { greska: "neispravan_unos", polje: "aaiHomeOrg" });
  const r = await posaljiInstituciju(PAYLOAD, klijent);
  assert.equal(r.ishod, "greska");
  assert.equal(r.kod, "neispravan_unos");
  assert.match(r.poruka, /aaiHomeOrg/);
});

test("a payload that cannot be sent is greska without any request", async () => {
  const r = await posaljiInstituciju({ ...PAYLOAD, format: "x" }, klijent);
  assert.equal(r.ishod, "greska");
  assert.equal(r.kod, "neispravan_payload");
  assert.equal(lazni.zahtjevi.length, 0);
});

test("401 (wrong token): retried, and the token is never in the message", async () => {
  const r = await posaljiInstituciju(PAYLOAD, { ...klijent, token: "b".repeat(40) });
  assert.deepEqual(r, { ishod: "ponovi", status: 401, poruka: "Institution_server odbija token (401)" });
  assert.equal(lazni.zahtjevi[0].headers.authorization, `Bearer ${"b".repeat(40)}`);
});

test("5xx and other statuses: retried", async () => {
  for (const status of [500, 502, 503, 404, 413]) {
    odgovori(status, {});
    const r = await posaljiInstituciju(PAYLOAD, klijent);
    assert.equal(r.ishod, "ponovi", String(status));
    assert.equal(r.status, status);
  }
});

test("a dropped connection or a server that is down: retried", async () => {
  lazni.odgovor = () => "prekini";
  assert.match((await posaljiInstituciju(PAYLOAD, klijent)).poruka, /nedostupan/);
  const dolje = await pokreniLazniInstitutionServer();
  const url = dolje.url;
  await dolje.zatvori();
  const r = await posaljiInstituciju(PAYLOAD, { ...klijent, url: `${url}${PUTANJA}` });
  assert.equal(r.ishod, "ponovi");
  assert.match(r.poruka, /nedostupan/);
});

test("timeout: an answer that never comes is retried after the timeout", async () => {
  lazni.odgovor = () => "visi";
  const t0 = Date.now();
  const r = await posaljiInstituciju(PAYLOAD, { ...klijent, timeoutMs: 300 });
  assert.equal(r.ishod, "ponovi");
  assert.match(r.poruka, /nije odgovorio u 0.3 s/);
  assert.ok(Date.now() - t0 < 5_000);
});
