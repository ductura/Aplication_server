import assert from "node:assert/strict";
import { test } from "node:test";

import * as route from "../app/api/admin/me/route.js";

const request = () => new Request("http://localhost/api/admin/me");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

test("deployed GET has no identity source and answers 401", async () => {
  const res = await route.GET(request());
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("non-admin identity gets 403 without echoing the identity", async () => {
  const GET = route.createAdminMeHandler(() => ({ role: "Admin", sub: "user-1" }));
  const res = await GET(request());
  assert.equal(res.status, 403);
  assert.equal(await res.text(), '{"error":"forbidden"}');
});

test("route exports only GET and no caching config", () => {
  assert.deepEqual(METHODS.filter((m) => m in route), ["GET"]);
  assert.equal(route.dynamic, undefined);
  assert.equal(route.revalidate, undefined);
});

test("admin identity gets 200 and exactly {role: admin}", async () => {
  const GET = route.createAdminMeHandler(async () => ({ role: "admin", sub: "user-1" }));
  const res = await GET(request());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { role: "admin" });
});
