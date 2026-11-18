import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { ROLES } from "../lib/auth/roles.js";
import { requireAdmin } from "../lib/auth/require-admin.js";

const denied = (status) => ({ ok: false, status });

class Identity {
  role = "admin";
}
const lyingTrap = { getOwnPropertyDescriptor: () => ({ value: "admin", configurable: true }) };
const revoked = Proxy.revocable({ role: "admin" }, {});
revoked.revoke();

// Not a plain object ({} literal or Object.create(null)): "no valid identity".
const NO_IDENTITY = [
  null, undefined, "", "admin", 0, 1, true, Symbol("admin"), ["admin"], () => {},
  new Identity(), Object.create({ role: "admin" }), { __proto__: { role: "admin" } },
  new Proxy({}, lyingTrap), new Proxy({ role: "admin" }, {}), revoked.proxy,
  vm.runInNewContext('({ role: "admin" })'),
];

NO_IDENTITY.forEach((identity, i) => {
  test(`401 for non-plain identity #${i} (${typeof identity})`, () => {
    assert.deepEqual(requireAdmin(identity), denied(401));
  });
});

const primitiveAdmin = { [Symbol.toPrimitive]: () => "admin" };
const stringifiesAdmin = { toString: () => "admin" };
const WRONG_ROLE = [
  "", "Admin", " admin", "admin ", "ADMIN", "admin\u0000", "аdmin",
  "toString", "__proto__", "constructor", "hasOwnProperty",
  ["admin"], {}, new String("admin"), primitiveAdmin, stringifiesAdmin, Symbol("admin"),
  1, null, undefined, true,
];

WRONG_ROLE.forEach((role, i) => {
  test(`403 for wrong role #${i} (${typeof role})`, () => {
    assert.deepEqual(requireAdmin({ role }), denied(403));
  });
});

test("403 for plain objects without an own role data property", () => {
  let reads = 0;
  const getter = { get role() { reads += 1; return "admin"; } };
  const shapes = [
    {}, { sub: "x" }, { roles: ["admin"] }, Object.create(null), getter,
    JSON.parse('{"__proto__": {"role": "admin"}}'),
  ];
  for (const identity of shapes) assert.deepEqual(requireAdmin(identity), denied(403));
  assert.equal(reads, 0, "getter is never called");
});

test("403 when only Object.prototype carries role", (t) => {
  Object.prototype.role = "admin";
  t.after(() => delete Object.prototype.role);
  assert.deepEqual(requireAdmin({}), denied(403));
});

test("admin passes, including null-prototype, frozen and non-enumerable role", () => {
  const nullProto = Object.assign(Object.create(null), { role: "admin" });
  const hidden = Object.defineProperty({}, "role", { value: "admin", enumerable: false });
  const admins = [{ role: "admin" }, { role: "admin", sub: "x" }, Object.freeze({ role: "admin" }), nullProto, hidden];
  for (const identity of admins) assert.deepEqual(requireAdmin(identity), { ok: true, role: "admin" });
});

test("ROLES is frozen and admin is the only role", () => {
  assert.deepEqual(ROLES, ["admin"]);
  assert.ok(Object.isFrozen(ROLES));
  assert.throws(() => ROLES.push("teacher"), TypeError);
});
