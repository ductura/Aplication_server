import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOST = "127.0.0.1";

export async function pokreniAplikaciju(t, fakultet, env) {
  // Next bundles the static catalog. Replace it only in a disposable copy.
  const local = join(ROOT, ".local");
  await mkdir(local, { recursive: true });
  if (relative(await realpath(ROOT), await realpath(local)) !== ".local") {
    throw new Error("Direktorij .local mora biti unutar ovog repozitorija.");
  }
  const dir = await mkdtemp(join(local, "int06-"));
  let child;
  let closed;
  t.after(async () => {
    try {
      child?.kill();
      await closed;
    } finally {
      if (relative(await realpath(local), dirname(await realpath(dir))) !== "") {
        throw new Error("Privremeni direktorij više nije unutar .local.");
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  for (const name of ["app", "admin", "institutions", "lib", "next.config.mjs", "package.json"]) {
    await cp(join(ROOT, name), join(dir, name), { recursive: true });
  }
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
  await writeFile(join(dir, "institutions/data/fakulteti.json"), JSON.stringify({
    izvor: "Sintetički katalog za INT-06",
    fakulteti: [fakultet],
  }));

  // The dev bundler owns file watchers. A dedicated process bounds their lifetime.
  child = fork(fileURLToPath(import.meta.url), [], {
    cwd: dir,
    env: { ...process.env, ...env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" },
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  closed = new Promise((resolve) => child.once("close", resolve));
  const [origin] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(60_000) }),
    closed.then((code) => { throw new Error(`Testni Next.js poslužitelj završio je prije pokretanja (${code}).`); }),
  ]);
  return origin;
}

if (process.send) {
  process.on("disconnect", () => process.exit());
  const { default: next } = await import("next");
  const server = createServer();
  server.listen(0, HOST);
  await once(server, "listening");
  const { port } = server.address();
  const app = next({ dev: true, webpack: true, dir: process.cwd(), hostname: HOST, port, httpServer: server });
  await app.prepare();
  server.on("request", app.getRequestHandler());
  process.send(`http://${HOST}:${port}`);
}
