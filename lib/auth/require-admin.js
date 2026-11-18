import { types } from "node:util";

import { ADMIN } from "./roles.js";

const NO_STORE = { "Cache-Control": "no-store" };

function deny(status, error, extraHeaders = {}) {
  return Response.json({ error }, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Returns null when the identity is an admin, otherwise the 401/403 Response to send.
// Only an own data property `role` that is exactly the string "admin" passes:
// inherited values, getters, String objects and look-alike strings are refused.
export function requireAdmin(identity) {
  if (!isPlainObject(identity)) {
    return deny(401, "unauthorized", { "WWW-Authenticate": "Bearer" });
  }
  const role = Object.getOwnPropertyDescriptor(identity, "role")?.value;
  if (role !== ADMIN) return deny(403, "forbidden");
  return null;
}
