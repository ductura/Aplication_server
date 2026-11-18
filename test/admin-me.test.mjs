import assert from "node:assert/strict";
import { test } from "node:test";

import * as route from "../app/api/admin/me/route.js";
import { createAdminMeHandler } from "../lib/auth/admin-me.js";

const URL = "http://localhost/api/admin/me";
const request = (method = "GET") => new Request(URL, { method });
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

test("deployed GET has no identity source and answers 401", async () => {
  const res = await route.GET(request());
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), "Bearer");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} /api/admin/me is 405 with Allow`, async () => {
    const res = await route[method](request(method));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(await res.text(), "");
  });
}

test("non-admin identity gets 403 without echoing the identity", async () => {
  const GET = createAdminMeHandler(() => ({ role: "Admin", sub: "user-1" }));
  const res = await GET(request());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("www-authenticate"), null);
  assert.equal(await res.text(), '{"error":"forbidden"}');
});

test("route exports every method but HEAD and no caching config", () => {
  const exported = Object.keys(route).sort();
  assert.deepEqual(exported, HTTP_METHODS.filter((m) => m !== "HEAD").sort());
});

test("admin identity gets 200 and exactly {role: admin}", async () => {
  const GET = createAdminMeHandler(async () => ({ role: "admin", sub: "user-1" }));
  const res = await GET(request());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { role: "admin" });
});
