import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const uses = [...ci.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];

test("workflow has no privileged trigger and only read permissions", () => {
  assert.doesNotMatch(ci, /pull_request_target|workflow_run|secrets\.|write-all|:\s*write\b/);
  assert.match(ci, /^permissions:\n {2}contents: read\n\n/m);
  assert.match(ci, /persist-credentials: false/);
});

test("every action is pinned to a full commit SHA with a version comment", () => {
  assert.ok(uses.length >= 3);
  for (const [line, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, line);
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, line);
  }
});

test("job runs install, lint, test and build in order on engines Node", () => {
  const runs = [...ci.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(runs, [
    "pnpm install --frozen-lockfile",
    "pnpm lint",
    "pnpm test",
    "pnpm build",
  ]);
  assert.match(ci, /node-version-file: package\.json/);
  assert.match(ci, /^ {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m);
});
