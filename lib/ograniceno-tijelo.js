// Bounded reading of a request body (plan scenario A02: the body is limited
// before it is loaded without control). A Content-Length that is malformed or
// larger than the limit is refused before a single byte is read; a body
// without Content-Length, or with a false one, is counted while it streams and
// the stream is cancelled as soon as the count passes the limit, so at most
// the limit plus one chunk is ever held in memory.

const DULJINA = /^\d{1,9}$/;

/**
 * The body as bytes, or null when it is (or claims to be) larger than `max`
 * bytes. An error of the underlying stream is passed on to the caller.
 */
export async function procitajOgranicenoTijelo(request, max) {
  const duljina = request.headers.get("content-length");
  if (duljina !== null && !(DULJINA.test(duljina) && Number(duljina) <= max)) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const dijelovi = [];
  let ukupno = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ukupno += value.byteLength;
    if (ukupno > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    dijelovi.push(value);
  }
  return Buffer.concat(dijelovi, ukupno);
}

/**
 * The body as UTF-8 text, or null when it is larger than `max` bytes. With
 * `fatal` (the default) invalid UTF-8 throws a TypeError; without it, invalid
 * sequences become U+FFFD, as `request.text()` does.
 */
export async function procitajOgranicenTekst(request, max, { fatal = true } = {}) {
  const bajtovi = await procitajOgranicenoTijelo(request, max);
  return bajtovi === null ? null : new TextDecoder("utf-8", { fatal }).decode(bajtovi);
}
