import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DIR = new URL("../.github/workflows/", import.meta.url);
// Normalised to LF so a Windows (CRLF) checkout tests the same content.
const ci = readFileSync(new URL("ci.yml", DIR), "utf8").replace(/\r\n/g, "\n");
// The reviewed ci.yml, byte for byte (LF). Any edit must update this hash in the same PR.
const REVIEWED_SHA256 = "1c2962dbacbd080f378fa2630e37047c1ba1cab892d24d1a7275cc58bf757300";

test("ci.yml is the only workflow", () => {
  assert.deepEqual(readdirSync(DIR), ["ci.yml"]);
});

test("ci.yml is exactly the reviewed workflow", () => {
  assert.equal(createHash("sha256").update(ci).digest("hex"), REVIEWED_SHA256);
});

test("reviewed workflow: read-only, no privileged triggers, no secrets", () => {
  assert.doesNotMatch(ci, /pull_request_target|workflow_run|issue_comment|secrets|github\.token|write/);
  assert.match(ci, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main, migracija\/faza2\]\n\npermissions:\n {2}contents: read\n\n/m);
  assert.equal(ci.match(/^ +permissions:/gm), null, "no job-level permissions");
  assert.equal(ci.match(/actions\/checkout@/g).length, ci.match(/persist-credentials: false/g).length);
});

test("reviewed workflow: actions pinned to full SHAs with a version comment", () => {
  const uses = [...ci.matchAll(/^ +- uses: (.+)$/gm)].map((m) => m[1]);
  assert.equal(uses.length, 7);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
});

test("reviewed workflow: install, lint, test, build and the database tests run in order (then the ci-ok script)", () => {
  const runs = [...ci.matchAll(/^ +(?:- )?run: (.+)$/gm)].map((m) => m[1]);
  const install = "pnpm install --frozen-lockfile";
  const audit = "pnpm audit --audit-level low";
  assert.deepEqual(runs, [
    "node --version", install, audit, "pnpm lint", "pnpm test", "pnpm build",
    install, "pnpm db:migrate", "pnpm test:db", "|",
  ]);
  assert.doesNotMatch(ci, /continue-on-error|if: false/);
});

test("reviewed workflow: the database job uses a pinned PostgreSQL image and a test database", () => {
  assert.match(ci, /^ {8}image: mirror\.gcr\.io\/library\/postgres:[\w.-]+@sha256:[0-9a-f]{64}$/m);
  assert.match(ci, /^ {6}DATABASE_URL: postgres:\/\/postgres@127\.0\.0\.1:5432\/ductura_test$/m);
});

test("reviewed workflow: ci-ok is the summary job over every real job and always runs", () => {
  const job = ci.slice(ci.indexOf("\n  ci-ok:\n"));
  assert.match(job, /^ {4}if: always\(\)$/m);
  assert.match(job, /^ {4}needs: \[check, db, dependency-review\]$/m);
  const jobs = [...ci.slice(ci.indexOf("\njobs:\n")).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(jobs, ["check", "db", "dependency-review", "ci-ok"]);
  assert.match(job, /^ {6}CHECK: \$\{\{ needs\.check\.result \}\}$/m);
  assert.match(job, /^ {6}DB: \$\{\{ needs\.db\.result \}\}$/m);
  assert.match(job, /^ {6}REVIEW: \$\{\{ needs\.dependency-review\.result \}\}$/m);
  assert.match(job, /test "\$CHECK" = success && test "\$DB" = success/);
  assert.match(job, /if \[ "\$EVENT" = pull_request \]; then test "\$REVIEW" = success; else test "\$REVIEW" = skipped; fi/);
  assert.doesNotMatch(job, /continue-on-error|uses:/);
});
