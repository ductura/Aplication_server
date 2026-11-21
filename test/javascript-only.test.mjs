import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const TS_FILE = /\.(ts|tsx|mts|cts)$/i;
const TS_CONFIG = /^tsconfig.*\.json$/i;

// Generated folders are skipped only at the repository root.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (dir !== ROOT || !SKIP_DIRS.has(entry.name)) out.push(...walk(join(dir, entry.name)));
    } else {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("repository has no TypeScript sources or tsconfig", () => {
  const files = walk(ROOT);
  assert.ok(files.some((f) => f.endsWith("route.js")), "walker must see the sources");
  const offending = files
    .map((f) => relative(ROOT, f))
    .filter((f) => TS_FILE.test(f) || TS_CONFIG.test(f.split(/[\\/]/).pop()));
  assert.deepEqual(offending, []);
});

test("package.json declares no TypeScript dependency or typecheck script", () => {
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  };
  const tsDeps = Object.keys(deps).filter((d) => d === "typescript" || d.startsWith("@types/"));
  assert.deepEqual(tsDeps, []);
  assert.equal(pkg.scripts.typecheck, undefined);
});

test("package.json scripts, packageManager and engines are the reviewed ones", () => {
  assert.deepEqual(pkg.scripts, {
    dev: "next dev -p 3110",
    build: "next build && node --test test/build-output.test.mjs test/server.test.mjs",
    start: "next start -p 3110",
    lint: "eslint . --max-warnings 0",
    test: "node --test test/health.test.mjs test/javascript-only.test.mjs test/ci-workflow.test.mjs test/institutions.test.mjs test/institutions-podigni.test.mjs test/admin-sesija.test.mjs test/admin-prijava.test.mjs test/admin-fakulteti.test.mjs test/institutions-detalj.test.mjs",
    "test:db": "node --test --test-concurrency=1 test/institutions-db.test.mjs test/institutions-podigni-db.test.mjs test/institutions-detalj-db.test.mjs test/admin-db.test.mjs",
    "db:migrate": "node institutions/migrate.js && node admin/migrate.js",
    "instance:podigni": "node institutions/podigni.js",
    "admin:stvori": "node admin/stvori.js",
  });
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, "^24.11.0 || ^26.0.0");
});

test("every test file is run by test, test:db or build", () => {
  const run = new Set(`${pkg.scripts.test} ${pkg.scripts["test:db"]} ${pkg.scripts.build}`.split(/\s+/));
  const entries = readdirSync(join(ROOT, "test"), { recursive: true, withFileTypes: true });
  for (const e of entries.filter((x) => !x.isDirectory())) {
    const file = relative(ROOT, join(e.parentPath, e.name)).split(/[\\/]/).join("/");
    assert.ok(run.has(file), file);
  }
});

test("lockfile resolves no typescript package", () => {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /\bnext@16\./, "lockfile must be readable");
  assert.doesNotMatch(lock, /^\s+'?typescript@/m);
});
