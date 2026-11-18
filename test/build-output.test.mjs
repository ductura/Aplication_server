// Runs as part of `pnpm build`, after `next build`, against the real build output.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NEXT = join(ROOT, ".next");

test("build did not generate TypeScript files", () => {
  assert.ok(existsSync(NEXT), "run after next build");
  for (const name of ["tsconfig.json", "next-env.d.ts"]) {
    assert.equal(existsSync(join(ROOT, name)), false, name);
  }
});

test("API routes are not prerendered as static content", () => {
  const manifest = JSON.parse(readFileSync(join(NEXT, "prerender-manifest.json"), "utf8"));
  const routes = Object.keys(manifest.routes);
  assert.ok(routes.includes("/"), "manifest must list the static home page");
  assert.equal(routes.includes("/api/health"), false);
  assert.equal(routes.includes("/api/admin/me"), false);
});

test("home page is rendered in Croatian", () => {
  const html = readFileSync(join(NEXT, "server", "app", "index.html"), "utf8");
  assert.match(html, /<html lang="hr"/);
  assert.match(html, /Aplikacijski poslužitelj radi\./);
});
