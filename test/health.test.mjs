import assert from "node:assert/strict";
import { test } from "node:test";

import * as route from "../app/api/health/route.js";

const URL = "http://localhost/api/health";
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

test("POST /api/health is rejected with 405 and an Allow header", async () => {
  const res = await route.POST(new Request(URL, { method: "POST", body: "{}" }));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), "");
});

test("route exports only GET and POST among HTTP methods", () => {
  const exported = HTTP_METHODS.filter((m) => m in route);
  assert.deepEqual(exported, ["GET", "POST"]);
});

test("GET /api/health returns 200 and exactly {status: ok}", async () => {
  const res = await route.GET(new Request(URL));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { status: "ok" });
});
