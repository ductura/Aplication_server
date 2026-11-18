// Runs as part of `pnpm build`: starts the production server and checks
// /api/health over real HTTP, including what Next answers on its own (HEAD).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NEXT_BIN = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
let server;
let base;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}/api/health`;
  server = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    if (await fetch(base, { signal }).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("next start did not answer within 10 s");
});

after(() => server?.kill());

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} is 405 with Allow over HTTP`, async () => {
    const res = await fetch(base, { method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "");
  });
}

test("OPTIONS is 204 with Allow over HTTP", async () => {
  const res = await fetch(base, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("HEAD and GET are 200 with no-store over HTTP", async () => {
  const head = await fetch(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  const get = await fetch(base);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(await get.text(), '{"status":"ok"}');
});
