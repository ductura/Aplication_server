// Applies institutions/migrations/*.sql in name order, each file in its own
// transaction, under one advisory lock so two servers starting together do
// not race. A file already applied is skipped; one whose content changed
// after it was applied stops the run.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = new URL("./migrations/", import.meta.url);
// Arbitrary constant: the advisory lock id of these migrations.
const LOCK_ID = 110_901;

export function migracije() {
  return readdirSync(DIR)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(new URL(name, DIR), "utf8").replace(/\r\n/g, "\n");
      return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") };
    });
}

export async function primijeniMigracije(pool) {
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS public.institutions_migration (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query("SELECT name, sha256 FROM public.institutions_migration");
    const done = new Map(rows.map((r) => [r.name, r.sha256]));
    for (const m of migracije()) {
      if (done.has(m.name)) {
        if (done.get(m.name) !== m.sha256) throw new Error(`migration ${m.name} changed after it was applied`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO public.institutions_migration (name, sha256) VALUES ($1, $2)", [m.name, m.sha256]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      applied.push(m.name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
  return applied;
}

// `pnpm db:migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dohvatiPool } = await import("./db.js");
  const pool = dohvatiPool();
  try {
    const applied = await primijeniMigracije(pool);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } finally {
    await pool.end();
  }
}
