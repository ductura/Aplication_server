// argon2id password hashes as PHC strings, with node:crypto (Node 24.7+), so
// the server has no native dependency. The parameters are read back from the
// stored string, so they can be raised later without breaking old hashes;
// verification refuses parameters outside sane bounds instead of running them.
import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

export const PARAMETRI = Object.freeze({ memory: 65_536, passes: 3, parallelism: 1, tagLength: 32 });
export const MIN_DULJINA = 12;
export const MAX_DULJINA = 1024;

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,86})$/;
const b64 = (buf) => buf.toString("base64").replace(/=+$/, "");

function izracunaj(lozinka, sol, { memory, passes, parallelism, tagLength }) {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      { message: Buffer.from(lozinka, "utf8"), nonce: sol, memory, passes, parallelism, tagLength },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hash a password; the result is a `$argon2id$v=19$...` PHC string. */
export async function hashirajLozinku(lozinka, parametri = PARAMETRI) {
  if (typeof lozinka !== "string" || lozinka.length === 0 || lozinka.length > MAX_DULJINA) {
    throw new TypeError("password must be a non-empty string of at most 1024 characters");
  }
  const sol = randomBytes(16);
  const kljuc = await izracunaj(lozinka, sol, parametri);
  const { memory, passes, parallelism } = parametri;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(sol)}$${b64(kljuc)}`;
}

/** True only when `hash` is a well-formed argon2id PHC string of `lozinka`. */
export async function provjeriLozinku(lozinka, hash) {
  if (typeof lozinka !== "string" || lozinka.length > MAX_DULJINA || typeof hash !== "string") return false;
  const m = PHC.exec(hash);
  if (!m) return false;
  const [memory, passes, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const sol = Buffer.from(m[4], "base64");
  const ocekivano = Buffer.from(m[5], "base64");
  if (memory < 8 * parallelism || memory > 262_144 || passes < 1 || passes > 10
      || parallelism < 1 || parallelism > 8 || sol.length < 8 || ocekivano.length < 16 || ocekivano.length > 64) {
    return false;
  }
  const kljuc = await izracunaj(lozinka, sol, { memory, passes, parallelism, tagLength: ocekivano.length });
  return timingSafeEqual(kljuc, ocekivano);
}

let lazni;
/**
 * A hash of a random password with the current parameters. Login verifies
 * against it when the user name does not exist, so a wrong name costs the
 * same time as a wrong password.
 */
export function lazniHash() {
  lazni ??= hashirajLozinku(randomBytes(24).toString("base64"));
  return lazni;
}
