// Test fixture only: a fake Institution_server for POST
// /internal/v1/institutions (contract on Ductus#2028 c.6993786629 §2). Each
// test sets `odgovor` to choose the answer; every request is recorded.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

export const LAZNI_TOKEN = "lazni-provisioning-token-".padEnd(48, "x");

/**
 * @returns {Promise<{url: string, zahtjevi: object[], odgovor: Function, vratiZadano: () => void, zatvori: () => Promise<void>}>}
 * odgovor(tijelo) returns {status, body}, or "visi" (never answers), or
 * "prekini" (drops the connection). The default answers like Institution_server:
 * 201 for a new slug, 200 for the same slug again.
 */
export async function pokreniLazniInstitutionServer() {
  const postojeci = new Map();
  const visi = new Set();
  const zadano = (t) => {
    const novi = !postojeci.has(t.slug);
    if (novi) postojeci.set(t.slug, randomUUID());
    return { status: novi ? 201 : 200, body: { institutionId: postojeci.get(t.slug), slug: t.slug, status: "aktivna" } };
  };
  const stanje = {
    zahtjevi: [],
    odgovor: zadano,
    vratiZadano() {
      stanje.odgovor = zadano;
    },
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let tijelo = null;
      try {
        tijelo = JSON.parse(raw);
      } catch {
        // recorded as null
      }
      stanje.zahtjevi.push({ method: req.method, url: req.url, headers: req.headers, tijelo });
      if (req.method !== "POST" || req.url !== "/internal/v1/institutions") {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${LAZNI_TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      const o = stanje.odgovor(tijelo);
      if (o === "visi") {
        visi.add(res);
        return;
      }
      if (o === "prekini") {
        req.socket.destroy();
        return;
      }
      res.writeHead(o.status, { "content-type": "application/json" }).end(JSON.stringify(o.body ?? null));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return Object.assign(stanje, {
    url: `http://127.0.0.1:${port}`,
    zatvori: async () => {
      for (const res of visi) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  });
}
