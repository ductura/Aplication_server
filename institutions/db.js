// One lazy pg pool for the server, from DATABASE_URL. Nothing connects at
// import time, so `next build` needs no database.
import pg from "pg";

let pool;

export function dohvatiPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({ connectionString, max: 5 });
  }
  return pool;
}
