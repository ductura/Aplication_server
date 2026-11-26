// Guards DAN-1533: .env.example lists every variable the code reads, and every
// JSON error answer of this server uses the single key `error`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const KORIJEN = new URL("..", import.meta.url).pathname;
const IZVORI = ["admin", "app", "institutions", "lib"];

function datoteke(dir) {
  const out = [];
  for (const ime of readdirSync(dir)) {
    const put = join(dir, ime);
    if (ime === "node_modules" || ime === "test-fixtures") continue;
    if (statSync(put).isDirectory()) out.push(...datoteke(put));
    else if (/\.(js|mjs)$/.test(ime)) out.push(put);
  }
  return out;
}
const kod = IZVORI.flatMap((d) => datoteke(join(KORIJEN, d))).map((p) => [p, readFileSync(p, "utf8")]);

test(".env.example names every variable the code reads (without values)", () => {
  const primjer = readFileSync(join(KORIJEN, ".env.example"), "utf8");
  const navedene = new Set([...primjer.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const procitane = new Set();
  for (const [, tekst] of kod) {
    for (const m of tekst.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)) procitane.add(m[1]);
  }
  procitane.delete("NODE_ENV");
  assert.ok(procitane.has("AAI_OIDC_ISSUER"), "the scan must see AAI_OIDC_ISSUER");
  for (const ime of procitane) assert.ok(navedene.has(ime), `${ime} is missing from .env.example`);
  assert.match(primjer, /^AAI_OIDC_ISSUER=$/m, "AAI_OIDC_ISSUER has no value in the example");
});

test("JSON error answers use the single key `error`, never `greska`", () => {
  const krivi = [];
  for (const [put, tekst] of kod) {
    if (put.endsWith("podigni.js")) continue; // reads Institution_server's own `greska` and uses it as a code
    if (/(?:json|Response\.json)\(\s*\{\s*greska\b/.test(tekst)) krivi.push(put);
  }
  assert.deepEqual(krivi, []);
});
