// Runs as part of `pnpm build`: starts the production server and checks
// /api/health and the home page over real HTTP, including what Next answers on
// its own (HEAD, X-Powered-By).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NEXT_BIN = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const REQUEST_TIMEOUT_MS = 5_000;
let server;
let origin;
let base;

// Every request after start-up has its own deadline and never follows a
// redirect, so each status asserted is the first answer the server sends.
const request = (url, init = {}) =>
  fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  base = `${origin}/api/health`;
  server = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    if (await fetch(base, { redirect: "manual", signal }).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("next start did not answer within 10 s");
});

after(() => server?.kill());

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} is 405 with Allow over HTTP`, async () => {
    const res = await request(base, { method });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "");
  });
}

test("OPTIONS is 204 with Allow over HTTP", async () => {
  const res = await request(base, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(await res.text(), "");
});

test("HEAD and GET are 200 with no-store over HTTP", async () => {
  const head = await request(base, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("cache-control"), "no-store");
  const get = await request(base);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "no-store");
  assert.equal(await get.text(), '{"status":"ok"}');
});

test("GET / is 200 without X-Powered-By on the production server", async () => {
  const res = await request(`${origin}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  await res.arrayBuffer();
});
