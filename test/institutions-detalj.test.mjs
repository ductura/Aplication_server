// GET /api/admin/institutions/{id} and POST .../ponovi without a database:
// session guard (401), unknown id (404), final state (409, Institution_server
// is not called) and the shape of the answers. The data layer is replaced.
import assert from "node:assert/strict";
import { before, test } from "node:test";

import * as detaljRoute from "../app/api/admin/institutions/[id]/route.js";
import * as ponoviRoute from "../app/api/admin/institutions/[id]/ponovi/route.js";
import { dohvatiDetalj, obradiDetalj, obradiPonovi } from "../institutions/detalj.js";
import { izdajToken, TRAJANJE_S } from "../lib/admin-sesija.js";

const ID = "3f1c2b8e-7a4d-4e1b-9c2a-5d6e7f8a9b0c";
const URL = `http://localhost/api/admin/institutions/${ID}`;

before(() => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "d".repeat(40);
});

const zahtjev = (cookie, method = "GET") =>
  new Request(URL, { method, headers: cookie === undefined ? {} : { cookie } });
const prijavljen = () => `ductura_admin=${izdajToken("ana")}`;

const detalj = (stanje, extra = {}) => ({
  id: ID,
  fakultetId: "fpzg",
  slug: "fpzg",
  naziv: "Fakultet političkih znanosti",
  aaiDomena: "fpzg.example.hr",
  issuer: "http://localhost:8090",
  racuni: { student: 3, institution_admin: 1 },
  stvorena: "2026-11-21T10:00:00.000Z",
  provisioning: {
    stanje,
    zatrazeno: "2026-11-21T10:00:00.000Z",
    aktivirano: null,
    institutionServerId: null,
    kodGreske: null,
    zadnjaGreska: null,
    ...extra,
  },
  pokusaji: { ukupno: 1, zadnji: "2026-11-21T10:01:00.000Z", zadnjaGreska: null, kodGreske: null },
});

// Dependencies that fail the test when the data layer or Institution_server is reached.
const nedostupno = {
  dohvati: async () => assert.fail("database reached"),
  podigni: async () => assert.fail("Institution_server reached"),
  konfiguriraj: () => assert.fail("configuration read"),
};

test("no, forged or expired admin session: 401 on both routes before anything else runs", async () => {
  const expired = izdajToken("ana", Date.now() - TRAJANJE_S * 1000 - 1000);
  for (const cookie of [undefined, "", `ductura_admin=${izdajToken("ana")}x`, `ductura_admin=${expired}`]) {
    for (const [obradi, method] of [
      [obradiDetalj, "GET"],
      [obradiPonovi, "POST"],
    ]) {
      const res = await obradi(zahtjev(cookie, method), ID, nedostupno);
      assert.equal(res.status, 401, `${method} ${cookie}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), { error: "nije_prijavljen" });
    }
  }
  // The real routes without a session do not touch the database either.
  delete process.env.DATABASE_URL;
  const params = { params: Promise.resolve({ id: ID }) };
  assert.equal((await detaljRoute.GET(zahtjev(), params)).status, 401);
  assert.equal((await ponoviRoute.POST(zahtjev(undefined, "POST"), params)).status, 401);
});

test("unknown or malformed id: 404 and no attempt", async () => {
  const deps = { ...nedostupno, dohvati: async () => null };
  for (const obradi of [obradiDetalj, obradiPonovi]) {
    const res = await obradi(zahtjev(prijavljen(), "POST"), ID, deps);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "nepoznata_institucija" });
  }
  // A malformed id is unknown before any query is made.
  for (const id of ["", "1", "nije-uuid", "../x", ID + "0", undefined]) {
    assert.equal(await dohvatiDetalj(id, { pool: { query: async () => assert.fail("queried") } }), null);
  }
});

test("GET answers with the institution, its request state and the attempts", async () => {
  const res = await obradiDetalj(zahtjev(prijavljen()), ID, {
    dohvati: async (id) => (assert.equal(id, ID), detalj("u_izradi", { zadnjaGreska: "Institution_server: greška 503" })),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { institucija } = await res.json();
  assert.deepEqual(Object.keys(institucija).sort(), [
    "aaiDomena", "fakultetId", "id", "issuer", "naziv", "pokusaji", "provisioning", "racuni", "slug", "stvorena",
  ]);
  assert.equal(institucija.provisioning.stanje, "u_izradi");
  assert.deepEqual(Object.keys(institucija.pokusaji).sort(), ["kodGreske", "ukupno", "zadnjaGreska", "zadnji"]);
  assert.equal(institucija.pokusaji.ukupno, 1);
});

test("POST ponovi on aktivna: 409 without Institution_server", async () => {
  const deps = { ...nedostupno, dohvati: async () => detalj("aktivna") };
  const res = await obradiPonovi(zahtjev(prijavljen(), "POST"), ID, deps);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "stanje_konacno", stanje: "aktivna" });
});

test("POST ponovi on zatrazena, u_izradi or greska makes one attempt tied to the attempts it saw", async () => {
  for (const prije of ["zatrazena", "u_izradi", "greska"]) {
    let stanje = prije;
    const pozivi = [];
    const res = await obradiPonovi(zahtjev(prijavljen(), "POST"), ID, {
      dohvati: async () => detalj(stanje),
      konfiguriraj: () => ({ url: "http://x/internal/v1/institutions", token: "t" }),
      podigni: async (o) => {
        pozivi.push(o);
        stanje = "aktivna";
        return [{ id: ID, stanje: "aktivna" }];
      },
    });
    assert.equal(res.status, 200, prije);
    assert.equal(pozivi.length, 1);
    assert.equal(pozivi[0].institutionId, ID);
    assert.equal(pozivi[0].ponoviGresku, true);
    assert.equal(pozivi[0].pokusaja, 1, "the attempt count of the view the retry was sent from");
    assert.equal((await res.json()).institucija.provisioning.stanje, "aktivna");
  }
});

test("POST ponovi that made no attempt: u_toku while still retryable, stanje_konacno once aktivna", async () => {
  for (const [sada, error] of [
    ["greska", "u_toku"],
    ["u_izradi", "u_toku"],
    ["aktivna", "stanje_konacno"],
  ]) {
    let stanje = "greska";
    const res = await obradiPonovi(zahtjev(prijavljen(), "POST"), ID, {
      dohvati: async () => detalj(stanje),
      konfiguriraj: () => ({ url: "http://x/internal/v1/institutions", token: "t" }),
      podigni: async () => ((stanje = sada), [{ id: ID, stanje: null }]),
    });
    assert.equal(res.status, 409, sada);
    assert.deepEqual(await res.json(), { error, stanje: sada });
  }
});

test("POST ponovi while another run holds the request: 409 u_toku; missing configuration: 503", async () => {
  const res = await obradiPonovi(zahtjev(prijavljen(), "POST"), ID, {
    dohvati: async () => detalj("u_izradi"),
    konfiguriraj: () => ({ url: "http://x", token: "t" }),
    podigni: async () => [{ id: ID, stanje: null, poruka: "zahtjev upravo podiže drugo pokretanje" }],
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "u_toku", stanje: "u_izradi" });

  const delete_ = { ...process.env };
  delete process.env.INSTITUTION_SERVER_URL;
  try {
    const bez = await obradiPonovi(zahtjev(prijavljen(), "POST"), ID, {
      dohvati: async () => detalj("zatrazena"),
      podigni: async () => assert.fail("Institution_server reached"),
    });
    assert.equal(bez.status, 503);
    assert.deepEqual(await bez.json(), { error: "podizanje_nije_podeseno" });
  } finally {
    Object.assign(process.env, delete_);
  }
});

test("wrong methods are 405 with Allow; OPTIONS is 204", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(detaljRoute[m]().headers.get("allow"), "GET, HEAD, OPTIONS");
  for (const m of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(ponoviRoute[m]().status, 405);
  assert.equal(ponoviRoute.OPTIONS().headers.get("allow"), "POST, OPTIONS");
  assert.equal(detaljRoute.OPTIONS().status, 204);
});
