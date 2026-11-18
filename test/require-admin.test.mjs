import assert from "node:assert/strict";
import { test } from "node:test";

import { ROLES } from "../lib/auth/roles.js";
import { requireAdmin } from "../lib/auth/require-admin.js";

async function expectDenied(identity, status) {
  const res = requireAdmin(identity);
  assert.ok(res instanceof Response, "denial is a Response");
  assert.equal(res.status, status);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const error = status === 401 ? "unauthorized" : "forbidden";
  assert.deepEqual(await res.json(), { error });
  assert.equal(res.headers.get("www-authenticate"), status === 401 ? "Bearer" : null);
}

const fn = () => {};
class Identity {
  role = "admin";
}
const proxy = new Proxy({}, { getOwnPropertyDescriptor: () => ({ value: "admin", configurable: true }) });
// Anything that is not a plain object ({} or Object.create(null)) is not an identity.
const NO_IDENTITY = [
  null, undefined, "", "admin", 0, 1, true, ["admin"], fn, Symbol("admin"),
  new Identity(), Object.create({ role: "admin" }), proxy, new Proxy({ role: "admin" }, {}),
];

for (const identity of NO_IDENTITY) {
  test(`401 when identity is ${typeof identity} #${NO_IDENTITY.indexOf(identity)}`, async () => {
    await expectDenied(identity, 401);
  });
}

const WRONG_ROLE = [
  "", "Admin", " admin", "admin ", "ADMIN", "admin\u0000", "аdmin",
  "toString", "__proto__", "constructor", "hasOwnProperty",
  ["admin"], {}, new String("admin"), 1, null, undefined, true,
];

for (const role of WRONG_ROLE) {
  test(`403 when role is ${JSON.stringify(role) ?? String(role)} (${typeof role})`, async () => {
    await expectDenied({ role }, 403);
  });
}

test("403 for objects without an own role data property", async () => {
  let reads = 0;
  const getter = { get role() { reads += 1; return "admin"; } };
  const shapes = [{}, { sub: "x" }, Object.create(null), getter];
  for (const identity of shapes) await expectDenied(identity, 403);
  assert.equal(reads, 0, "getter is never called");
});

test("403 when only Object.prototype carries role", async () => {
  Object.prototype.role = "admin";
  try {
    await expectDenied({}, 403);
  } finally {
    delete Object.prototype.role;
  }
});

test("admin passes", () => {
  for (const identity of [{ role: "admin" }, { role: "admin", sub: "x" }, Object.freeze({ role: "admin" })]) {
    assert.equal(requireAdmin(identity), null);
  }
});

test("ROLES is frozen and admin is the only role", () => {
  assert.deepEqual(ROLES, ["admin"]);
  assert.ok(Object.isFrozen(ROLES));
  assert.throws(() => ROLES.push("teacher"), TypeError);
});
