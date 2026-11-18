// The platform admin session: a token signed with HMAC-SHA256 in the
// `ductura_admin` cookie (contract Ductus#2028 c.6993786629 §3.4). The token
// is stateless: it names the admin and its expiry (8 h). The secret is
// DUCTURA_ADMIN_TOKEN_SECRET (at least 32 characters); rotating it ends every
// session. Without the secret nobody is an admin.
//
// adminIzZahtjeva(request) is the one guard every admin route uses.
import { createHmac, timingSafeEqual } from "node:crypto";

export const KOLACIC = "ductura_admin";
export const TRAJANJE_S = 8 * 60 * 60;
export const KORISNICKO_IME = /^[a-z0-9._-]{3,40}$/;
const VERZIJA = "v1";
const TOKEN = /^v1\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/;

/** The signing secret, or null when it is missing or too short. */
export function tajna() {
  const s = process.env.DUCTURA_ADMIN_TOKEN_SECRET;
  return typeof s === "string" && s.length >= 32 ? s : null;
}

const potpis = (secret, payload) =>
  createHmac("sha256", secret).update(`${KOLACIC}.${VERZIJA}.${payload}`, "utf8").digest();

/** Issue a token for a normalised user name. Throws without a secret. */
export function izdajToken(korisnickoIme, nowMs = Date.now()) {
  const secret = tajna();
  if (!secret) throw new Error("DUCTURA_ADMIN_TOKEN_SECRET is not set");
  if (typeof korisnickoIme !== "string" || !KORISNICKO_IME.test(korisnickoIme)) throw new TypeError("invalid user name");
  const iat = Math.floor(nowMs / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: korisnickoIme, iat, exp: iat + TRAJANJE_S })).toString("base64url");
  return `${VERZIJA}.${payload}.${potpis(secret, payload).toString("base64url")}`;
}

/** The user name of a valid, unexpired token, or null. */
export function provjeriToken(token, nowMs = Date.now()) {
  const secret = tajna();
  if (!secret || typeof token !== "string") return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  const sig = Buffer.from(m[2], "base64url");
  if (sig.length !== 32 || !timingSafeEqual(sig, potpis(secret, m[1]))) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims === null || typeof claims !== "object") return null;
  const { sub, iat, exp } = claims;
  const now = Math.floor(nowMs / 1000);
  if (typeof sub !== "string" || !KORISNICKO_IME.test(sub)) return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp - iat !== TRAJANJE_S) return null;
  if (iat > now + 60 || exp <= now) return null;
  return sub;
}

/** Value of the admin cookie in a Cookie header; null when absent or sent twice. */
export function tokenIzKolacica(cookieHeader) {
  if (typeof cookieHeader !== "string") return null;
  const values = [];
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === KOLACIC) values.push(part.slice(eq + 1).trim());
  }
  return values.length === 1 ? values[0] : null;
}

/** @returns {null | {korisnickoIme: string}} the signed-in platform admin. */
export function adminIzZahtjeva(request, nowMs = Date.now()) {
  const korisnickoIme = provjeriToken(tokenIzKolacica(request.headers.get("cookie")), nowMs);
  return korisnickoIme ? { korisnickoIme } : null;
}

const atributi = () => `HttpOnly; SameSite=Strict; Path=/${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;

export const kolacicPrijave = (token) => `${KOLACIC}=${token}; Max-Age=${TRAJANJE_S}; ${atributi()}`;
export const kolacicOdjave = () => `${KOLACIC}=; Max-Age=0; ${atributi()}`;
