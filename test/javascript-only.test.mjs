import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const TS_FILE = /\.(ts|tsx|mts|cts)$/;
const TS_CONFIG = /^tsconfig.*\.json$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(join(dir, entry.name)));
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

test("package.json has the required scripts, packageManager and engines", () => {
  for (const name of ["dev", "build", "start", "lint", "test"]) {
    assert.equal(typeof pkg.scripts[name], "string", `script ${name}`);
  }
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+/);
  assert.equal(pkg.engines.node, "^24.11.0 || ^26.0.0");
});

test("lockfile resolves no typescript package", () => {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, /\bnext@16\./, "lockfile must be readable");
  assert.doesNotMatch(lock, /^\s+'?typescript@/m);
});
