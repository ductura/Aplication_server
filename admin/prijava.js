// Handlers of /api/admin/prijava, /api/admin/odjava and /api/admin/ja
// (contract Ductus#2028 c.6993786629 §3.4). A platform admin signs in with a
// user name and a password; the answer to every failed attempt is the same
// 401 prijava_neuspjesna, and the password hash is checked even when the name
// does not exist. Attempts are limited per name and per IP.
import { dohvatiPool } from "../institutions/db.js";
import {
  KORISNICKO_IME,
  adminIzZahtjeva,
  izdajToken,
  kolacicOdjave,
  kolacicPrijave,
  tajna,
} from "../lib/admin-sesija.js";
import { MAX_DULJINA, lazniHash, provjeriLozinku } from "./lozinka.js";
import { OgranicenjePokusaja } from "./ogranicenje.js";

export const MAX_TIJELO = 4 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const POLJA = new Set(["korisnickoIme", "lozinka"]);

const json = (body, status, headers = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** Trim and lower case; null unless the result is a valid user name. */
export function normalizirajIme(ime) {
  if (typeof ime !== "string" || ime.length > 200) return null;
  const n = ime.trim().toLowerCase();
  return KORISNICKO_IME.test(n) ? n : null;
}

/** The address the nearest proxy saw: the last X-Forwarded-For entry. */
export function ipIzZahtjeva(request) {
  const zadnji = (request.headers.get("x-forwarded-for") ?? "").split(",").at(-1).trim();
  return zadnji && zadnji.length <= 64 ? zadnji : "nepoznata";
}

/** The body as text, or null when it is larger than `max` bytes. */
async function procitajTijelo(request, max) {
  const duljina = request.headers.get("content-length");
  if (duljina !== null && !(/^\d{1,9}$/.test(duljina) && Number(duljina) <= max)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const dijelovi = [];
  let ukupno = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ukupno += value.byteLength;
    if (ukupno > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    dijelovi.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(dijelovi));
}

async function nadjiHashIzBaze(korisnickoIme) {
  const { rows } = await dohvatiPool().query(
    "SELECT lozinka_hash FROM admin.platform_admin WHERE korisnicko_ime = $1",
    [korisnickoIme],
  );
  return rows[0]?.lozinka_hash ?? null;
}

const zadanoOgranicenje = new OgranicenjePokusaja();

export function napraviPrijavu({
  nadjiHash = nadjiHashIzBaze,
  ogranicenje = zadanoOgranicenje,
  provjeri = provjeriLozinku,
  sad = Date.now,
} = {}) {
  return async function POST(request) {
    if (!tajna()) return json({ greska: "prijava_nije_dostupna" }, 503);
    if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
      return json({ greska: "ocekuje_se_json" }, 415);
    }
    let ulaz;
    try {
      const tekst = await procitajTijelo(request, MAX_TIJELO);
      if (tekst === null) return json({ greska: "prevelik_zahtjev" }, 413);
      ulaz = JSON.parse(tekst);
    } catch {
      return json({ greska: "neispravan_json" }, 400);
    }

    const objekt = ulaz !== null && typeof ulaz === "object" && !Array.isArray(ulaz);
    const ime = objekt ? normalizirajIme(ulaz.korisnickoIme) : null;
    const kljucevi = [`ip:${ipIzZahtjeva(request)}`, ...(ime ? [`ime:${ime}`] : [])];
    const pokusaj = ogranicenje.zauzmi(kljucevi, sad());
    if (!pokusaj.dopusteno) {
      return json({ greska: "previse_pokusaja" }, 429, { "Retry-After": String(pokusaj.retryAfterS) });
    }

    const lozinka = objekt ? ulaz.lozinka : undefined;
    const ispravanOblik = objekt && ime !== null
      && Object.keys(ulaz).every((k) => POLJA.has(k))
      && typeof lozinka === "string" && lozinka.length >= 1 && lozinka.length <= MAX_DULJINA;
    const hash = ispravanOblik ? await nadjiHash(ime) : null;
    // Always one argon2id verification, so the answer takes as long for an
    // unknown name or a malformed body as for a wrong password.
    const tocna = await provjeri(ispravanOblik ? lozinka : "-", hash ?? (await lazniHash()));
    if (!ispravanOblik || hash === null || !tocna) return json({ greska: "prijava_neuspjesna" }, 401);

    pokusaj.otpusti();
    return json({ korisnickoIme: ime }, 200, { "Set-Cookie": kolacicPrijave(izdajToken(ime, sad())) });
  };
}

export function odjava() {
  return new Response(null, { status: 204, headers: { ...NO_STORE, "Set-Cookie": kolacicOdjave() } });
}

export function ja(request) {
  const admin = adminIzZahtjeva(request);
  return admin ? json({ korisnickoIme: admin.korisnickoIme }, 200) : json({ greska: "nije_prijavljen" }, 401);
}

/** OPTIONS and 405 handlers for a route that allows `allow`. */
export function ostaleMetode(allow) {
  const headers = { ...NO_STORE, Allow: allow };
  return {
    OPTIONS: () => new Response(null, { status: 204, headers }),
    nedopusteno: () => new Response(null, { status: 405, headers }),
  };
}
