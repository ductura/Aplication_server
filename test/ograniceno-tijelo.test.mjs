// lib/ograniceno-tijelo.js and its use in POST /api/admin/institutions and
// POST /api/admin/prijava: a body is limited before it is loaded (plan A02).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { napraviPrijavu } from "../admin/prijava.js";
import { OgranicenjePokusaja } from "../admin/ogranicenje.js";
import * as institucije from "../app/api/admin/institutions/route.js";
import { izdajToken } from "../lib/admin-sesija.js";
import { procitajOgranicenoTijelo, procitajOgranicenTekst } from "../lib/ograniceno-tijelo.js";

const SECRET = "t".repeat(40);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["DUCTURA_ADMIN_TOKEN_SECRET", "DATABASE_URL"]) {
    if (k in saved) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

// A stream that makes one `komad`-byte chunk per pull, `broj` chunks in all,
// and records how much was pulled and whether it was cancelled. With a high
// water mark of 0 nothing is pulled until a reader asks for it.
function brojeciTok(komad, broj) {
  const stanje = { povuceno: 0, poziva: 0, otkazano: false };
  let i = 0;
  const tok = new ReadableStream(
    {
      pull(c) {
        stanje.poziva += 1;
        if (i >= broj) return c.close();
        i += 1;
        stanje.povuceno += komad;
        c.enqueue(new Uint8Array(komad).fill(0x20));
      },
      cancel() {
        stanje.otkazano = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { tok, stanje };
}

// A minimal request: only the two members the reader uses.
const zahtjev = (body, headers = {}) => ({ headers: new Headers(headers), body });

test("a chunked body without Content-Length larger than the limit: null after at most the limit and one chunk", async () => {
  const { tok, stanje } = brojeciTok(1000, 100);
  assert.equal(await procitajOgranicenoTijelo(zahtjev(tok), 4096), null);
  assert.ok(stanje.povuceno <= 4096 + 1000, `pulled ${stanje.povuceno}`);
  assert.equal(stanje.povuceno, 5000, "stops at the first chunk past the limit");
  assert.equal(stanje.otkazano, true, "the rest of the stream is cancelled");
});

test("a Content-Length larger than the limit, or malformed, is refused without reading", async () => {
  for (const duljina of ["4097", "99999999999", "1e3", "-1", "abc", "10, 10", "0x10", ""]) {
    const { tok, stanje } = brojeciTok(10, 1);
    assert.equal(await procitajOgranicenoTijelo(zahtjev(tok, { "content-length": duljina }), 4096), null, duljina);
    assert.equal(stanje.poziva, 0, `${duljina}: nothing pulled`);
    assert.equal(tok.locked, false, `${duljina}: no reader taken`);
  }
});

test("a Content-Length smaller than the body does not get it through", async () => {
  const { tok, stanje } = brojeciTok(1000, 10);
  assert.equal(await procitajOgranicenoTijelo(zahtjev(tok, { "content-length": "10" }), 4096), null);
  assert.equal(stanje.povuceno, 5000);
  assert.equal(stanje.otkazano, true);
});

test("a body of exactly the limit, an empty body and no body are read", async () => {
  const { tok } = brojeciTok(1024, 4);
  const bajtovi = await procitajOgranicenoTijelo(zahtjev(tok, { "content-length": "4096" }), 4096);
  assert.equal(bajtovi.byteLength, 4096);
  assert.equal((await procitajOgranicenoTijelo(zahtjev(null), 4096)).byteLength, 0);
  assert.equal((await procitajOgranicenoTijelo(zahtjev(brojeciTok(1, 0).tok, { "content-length": "0" }), 0)).byteLength, 0);
  const req = new Request("http://localhost/", { method: "POST", body: '{"a":"č"}' });
  assert.equal(await procitajOgranicenTekst(req, 4096), '{"a":"č"}');
});

test("text: invalid UTF-8 throws by default and becomes U+FFFD without fatal", async () => {
  const los = () => new Request("http://localhost/", { method: "POST", body: new Uint8Array([0x7b, 0xff, 0x7d]) });
  await assert.rejects(procitajOgranicenTekst(los(), 4096), TypeError);
  assert.equal(await procitajOgranicenTekst(los(), 4096, { fatal: false }), "{�}");
  assert.equal(await procitajOgranicenTekst(zahtjev(null, { "content-length": "5000" }), 4096), null);
});

const tokZahtjev = (url, tok, headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: tok,
    duplex: "half",
  });

test("POST /api/admin/institutions: an oversized chunked body gets 413 after at most 16 KiB and one chunk", async () => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = SECRET;
  delete process.env.DATABASE_URL;
  const cookie = `ductura_admin=${izdajToken("ana", Date.now())}`;
  const url = "http://localhost/api/admin/institutions";

  const { tok, stanje } = brojeciTok(4000, 100);
  let res = await institucije.POST(tokZahtjev(url, tok, { cookie }));
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "prevelik_zahtjev" });
  assert.ok(stanje.povuceno <= 16 * 1024 + 4000, `pulled ${stanje.povuceno}`);
  assert.equal(stanje.otkazano, true);

  const lazni = brojeciTok(10, 1);
  res = await institucije.POST(tokZahtjev(url, lazni.tok, { cookie, "content-length": String(16 * 1024 + 1) }));
  assert.equal(res.status, 413);
  assert.equal(lazni.stanje.poziva, 0, "a false Content-Length is refused without reading");

  // No session: 401 before the body is touched.
  const bez = brojeciTok(4000, 100);
  res = await institucije.POST(tokZahtjev(url, bez.tok));
  assert.equal(res.status, 401);
  assert.equal(bez.stanje.poziva, 0);
});

test("POST /api/admin/prijava: an oversized chunked body gets 413 after at most 4 KiB and one chunk", async () => {
  process.env.DUCTURA_ADMIN_TOKEN_SECRET = SECRET;
  const prijava = napraviPrijavu({
    nadjiHash: async () => null,
    ogranicenje: new OgranicenjePokusaja(),
    provjeri: async () => false,
  });
  const url = "http://localhost/api/admin/prijava";

  const { tok, stanje } = brojeciTok(1000, 100);
  let res = await prijava(tokZahtjev(url, tok));
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "prevelik_zahtjev" });
  assert.ok(stanje.povuceno <= 4 * 1024 + 1000, `pulled ${stanje.povuceno}`);
  assert.equal(stanje.otkazano, true);

  const lazni = brojeciTok(10, 1);
  res = await prijava(tokZahtjev(url, lazni.tok, { "content-length": "99999999999" }));
  assert.equal(res.status, 413);
  assert.equal(lazni.stanje.poziva, 0, "a false Content-Length is refused without reading");
});
