// GET /api/admin/fakulteti: the faculty list for the admin form, behind the
// platform admin session.
import assert from "node:assert/strict";
import { before, test } from "node:test";

import * as route from "../app/api/admin/fakulteti/route.js";
import { FAKULTETI } from "../institutions/fakulteti.js";
import { izdajToken, TRAJANJE_S } from "../lib/admin-sesija.js";

const URL = "http://localhost/api/admin/fakulteti";
const get = (cookie) => route.GET(new Request(URL, { headers: cookie === undefined ? {} : { cookie } }));

before(() => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = "f".repeat(40);
});

test("a signed-in admin gets every faculty as {id, naziv, web}", async () => {
  const res = get(`ductura_admin=${izdajToken("ana")}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { fakulteti } = await res.json();
  assert.equal(fakulteti.length, 32);
  assert.deepEqual(fakulteti, FAKULTETI.map((f) => ({ id: f.id, naziv: f.naziv, web: f.web })));
  assert.deepEqual(fakulteti.find((f) => f.id === "fpzg"), { id: "fpzg", naziv: "Fakultet političkih znanosti", web: "http://www.fpzg.hr" });
});

test("no, forged or expired session: 401", async () => {
  const token = izdajToken("ana");
  const expired = izdajToken("ana", Date.now() - TRAJANJE_S * 1000 - 1000);
  for (const cookie of [undefined, "", `ductura_admin=${token}x`, `ductura_admin=${expired}`, `other=${token}`]) {
    const res = get(cookie);
    assert.equal(res.status, 401, String(cookie));
    assert.deepEqual(await res.json(), { error: "nije_prijavljen" });
  }
  const bearer = route.GET(new Request(URL, { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(bearer.status, 401);
});

test("other methods are 405 with Allow; OPTIONS is 204", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = route[m]();
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
  assert.equal(route.OPTIONS().status, 204);
});
