// `pnpm admin:stvori <ime> [--zamijeni]`: creates a platform admin, or with
// --zamijeni sets a new password for an existing one. The password is read
// from stdin (without echo on a terminal) and never from the arguments, so it
// does not land in shell history or the process list; nothing prints it.
import { fileURLToPath } from "node:url";

import { hashirajLozinku, MAX_DULJINA, MIN_DULJINA } from "./lozinka.js";
import { normalizirajIme } from "./prijava.js";

export class AdminGreska extends Error {
  constructor(kod, poruka) {
    super(poruka);
    this.kod = kod;
  }
}

/** @returns {Promise<{korisnickoIme: string, novo: boolean}>} */
export async function stvoriAdmina({ korisnickoIme, lozinka, zamijeni = false }, { pool }) {
  const ime = normalizirajIme(korisnickoIme);
  if (!ime) {
    throw new AdminGreska("neispravno_ime", "korisničko ime: 3 do 40 znakova a-z, 0-9, točka, crtica ili podvlaka");
  }
  if (typeof lozinka !== "string" || [...lozinka].length < MIN_DULJINA) {
    throw new AdminGreska("prekratka_lozinka", `lozinka mora imati najmanje ${MIN_DULJINA} znakova`);
  }
  if (lozinka.length > MAX_DULJINA) throw new AdminGreska("preduga_lozinka", `lozinka smije imati najviše ${MAX_DULJINA} znakova`);
  const hash = await hashirajLozinku(lozinka);
  const { rows } = await pool.query(
    zamijeni
      ? `INSERT INTO admin.platform_admin (korisnicko_ime, lozinka_hash) VALUES ($1, $2)
         ON CONFLICT (korisnicko_ime) DO UPDATE SET lozinka_hash = EXCLUDED.lozinka_hash
         RETURNING (xmax = 0) AS novo`
      : `INSERT INTO admin.platform_admin (korisnicko_ime, lozinka_hash) VALUES ($1, $2)
         ON CONFLICT (korisnicko_ime) DO NOTHING RETURNING true AS novo`,
    [ime, hash],
  );
  if (rows.length === 0) throw new AdminGreska("vec_postoji", `admin ${ime} već postoji (nova lozinka: --zamijeni)`);
  return { korisnickoIme: ime, novo: rows[0].novo };
}

/** One line from a terminal without echo. */
function procitajSkriveno(upit) {
  const stdin = process.stdin;
  process.stderr.write(upit);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let s = "";
    const kraj = () => {
      stdin.off("data", naUnos);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    function naUnos(dio) {
      for (const znak of dio) {
        if (znak === "\r" || znak === "\n" || znak === "\u0004") {
          kraj();
          return resolve(s);
        }
        if (znak === "\u0003") {
          kraj();
          return reject(new AdminGreska("prekinuto", "prekinuto"));
        }
        if (znak === "\u007f" || znak === "\b") s = [...s].slice(0, -1).join("");
        else s += znak;
      }
    }
    stdin.on("data", naUnos);
  });
}

/** The first line of a piped stdin. */
async function procitajCijev() {
  let tekst = "";
  for await (const dio of process.stdin) {
    tekst += dio;
    if (tekst.length > 4 * MAX_DULJINA) break;
  }
  return tekst.split(/\r?\n/)[0];
}

async function procitajLozinku() {
  if (!process.stdin.isTTY) return procitajCijev();
  const prva = await procitajSkriveno("Lozinka: ");
  const druga = await procitajSkriveno("Ponovi lozinku: ");
  if (prva !== druga) throw new AdminGreska("lozinke_razlicite", "lozinke se ne podudaraju");
  return prva;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const zamijeni = args.includes("--zamijeni");
  const ostalo = args.filter((a) => a !== "--zamijeni");
  if (ostalo.length !== 1) {
    console.error("upotreba: pnpm admin:stvori <korisničko ime> [--zamijeni]  (lozinka se čita sa stdin)");
    process.exit(2);
  }
  const { dohvatiPool } = await import("../institutions/db.js");
  let pool;
  try {
    if (!normalizirajIme(ostalo[0])) throw new AdminGreska("neispravno_ime", "korisničko ime: 3 do 40 znakova a-z, 0-9, točka, crtica ili podvlaka");
    const lozinka = await procitajLozinku();
    pool = dohvatiPool();
    const { korisnickoIme, novo } = await stvoriAdmina({ korisnickoIme: ostalo[0], lozinka, zamijeni }, { pool });
    console.log(novo ? `admin ${korisnickoIme} je stvoren` : `admin ${korisnickoIme} ima novu lozinku`);
  } catch (err) {
    console.error(err instanceof AdminGreska ? err.message : `greška: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
