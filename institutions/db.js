// Lazy pg pools, from the environment. Nothing connects at import time, so
// `next build` needs no database.
//
// The application pool (DATABASE_URL) always runs as ductura_app, the role of
// least privilege the migrations create (DAN-1531): every new connection does
// SET ROLE ductura_app and is refused unless it then really is that role and
// that role cannot bypass row level security. So a login role with more
// rights (locally `postgres`) still only gets what the application needs. In
// production the login role should itself be only a member of ductura_app,
// because a superuser login could RESET ROLE.
//
// The owner pool (DATABASE_OWNER_URL, else DATABASE_URL) keeps the login
// role: migrations and `pnpm admin:stvori` need the owner's rights.
import pg from "pg";

export const APP_ULOGA = "ductura_app";

const PROVJERA_ULOGE = `SELECT current_user = $1 AND NOT r.rolsuper AND NOT r.rolbypassrls AS ok
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

export class AplikacijskiKlijent extends pg.Client {
  connect(callback) {
    const spojeno = super
      .connect()
      .then(() => this.query(`SET ROLE ${APP_ULOGA}`))
      .then(() => this.query(PROVJERA_ULOGE, [APP_ULOGA]))
      .then(({ rows }) => {
        if (rows[0]?.ok !== true) throw new Error(`database connection does not run as ${APP_ULOGA}`);
      })
      .catch(async (err) => {
        await this.end().catch(() => {});
        throw err;
      });
    if (typeof callback !== "function") return spojeno;
    spojeno.then(
      () => callback(null, this),
      (err) => callback(err),
    );
    return undefined;
  }
}

/** A pool whose every connection runs as ductura_app. */
export function stvoriAplikacijskiPool(connectionString, { max = 5 } = {}) {
  return new pg.Pool({ connectionString, max, Client: AplikacijskiKlijent });
}

let pool;
let vlasnickiPool;

export function dohvatiPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = stvoriAplikacijskiPool(connectionString);
  }
  return pool;
}

export function dohvatiVlasnickiPool() {
  if (!vlasnickiPool) {
    const connectionString = process.env.DATABASE_OWNER_URL || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_OWNER_URL or DATABASE_URL is not set");
    vlasnickiPool = new pg.Pool({ connectionString, max: 2 });
  }
  return vlasnickiPool;
}
