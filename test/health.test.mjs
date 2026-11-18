import assert from "node:assert/strict";
import { test } from "node:test";

import * as route from "../app/api/health/route.js";

const URL = "http://localhost/api/health";
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALLOW = "GET, HEAD, OPTIONS";

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} /api/health is rejected with 405, Allow and an empty body`, async () => {
    const res = await route[method](new Request(URL, { method, body: "{}" }));
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), ALLOW);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "");
  });
}

test("OPTIONS advertises the same Allow as the 405 responses", async () => {
  const res = await route.OPTIONS(new Request(URL, { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("allow"), ALLOW);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), "");
});

test("route exports every method but HEAD and no caching config", () => {
  const exported = HTTP_METHODS.filter((m) => m in route);
  assert.deepEqual(exported, ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  assert.equal(route.dynamic, undefined);
  assert.equal(route.revalidate, undefined);
});

test("GET /api/health returns 200 and exactly {status: ok}", async () => {
  const res = await route.GET(new Request(URL));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { status: "ok" });
});
