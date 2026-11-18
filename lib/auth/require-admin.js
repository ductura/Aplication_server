import { types } from "node:util";

import { ADMIN } from "./roles.js";

// A valid identity is a plain object: prototype Object.prototype or null, not a
// proxy. Class instances, objects from another realm and non-objects count as
// "no valid identity" (401) on purpose.
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Pure decision, no HTTP: { ok: true, role } only for an own data property
// `role` that is exactly "admin"; otherwise { ok: false, status: 401 | 403 }.
// Inherited values, getters, String objects and look-alike strings are refused.
export function requireAdmin(identity) {
  if (!isPlainObject(identity)) return { ok: false, status: 401 };
  const role = Object.getOwnPropertyDescriptor(identity, "role")?.value;
  if (role !== ADMIN) return { ok: false, status: 403 };
  return { ok: true, role };
}
