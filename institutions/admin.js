// Gate for /api/admin/institutions.
//
// TODO(admin session): main has no admin session yet (the admin role is
// DAN-1104, not merged). Replace this gate with the admin session check once
// it lands. Until then the routes stay closed: without
// INSTITUTIONS_ADMIN_TOKEN in the server environment they answer 503, and a
// request without that exact bearer token gets 401. This is an operator key
// for the server API only; it is no way for a person to sign in (D-09).
import { createHash, timingSafeEqual } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest();

/** @returns {null | {status: number, error: string}} null when the caller may pass. */
export function provjeriAdmina(request) {
  const token = process.env.INSTITUTIONS_ADMIN_TOKEN;
  if (!token || token.length < 32) return { status: 503, error: "admin_nije_dostupan" };
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([!-~]{1,512})$/.exec(header);
  if (!m || !timingSafeEqual(sha256(m[1]), sha256(token))) return { status: 401, error: "nije_prijavljen" };
  return null;
}
