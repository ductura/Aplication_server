// In-memory limit of login attempts: at most `najvise` attempts per key in a
// sliding window. A login reserves one attempt on each of its keys (user name
// and IP) before the password is checked, so parallel requests cannot all slip
// past the count; a successful login gives its attempt back. One server
// process holds one limiter; a restart clears it.
export class OgranicenjePokusaja {
  #mapa = new Map();

  constructor({ najvise = 5, prozorMs = 15 * 60_000, najviseKljuceva = 50_000 } = {}) {
    this.najvise = najvise;
    this.prozorMs = prozorMs;
    this.najviseKljuceva = najviseKljuceva;
  }

  #svjezi(kljuc, now) {
    const sve = this.#mapa.get(kljuc);
    if (!sve) return [];
    const svjeze = sve.filter((t) => t > now - this.prozorMs);
    if (svjeze.length) this.#mapa.set(kljuc, svjeze);
    else this.#mapa.delete(kljuc);
    return svjeze;
  }

  #pocisti(now) {
    for (const kljuc of [...this.#mapa.keys()]) this.#svjezi(kljuc, now);
    // Still full: drop the keys seen first, so memory stays bounded.
    for (const kljuc of this.#mapa.keys()) {
      if (this.#mapa.size < this.najviseKljuceva) break;
      this.#mapa.delete(kljuc);
    }
  }

  /**
   * Reserve one attempt on every key, or none when any key is used up.
   * @returns {{dopusteno: true, otpusti: () => void} | {dopusteno: false, retryAfterS: number}}
   */
  zauzmi(kljucevi, now = Date.now()) {
    let cekajMs = 0;
    for (const kljuc of kljucevi) {
      const svjeze = this.#svjezi(kljuc, now);
      if (svjeze.length >= this.najvise) cekajMs = Math.max(cekajMs, svjeze[0] + this.prozorMs - now);
    }
    if (cekajMs > 0) return { dopusteno: false, retryAfterS: Math.max(1, Math.ceil(cekajMs / 1000)) };
    if (this.#mapa.size + kljucevi.length > this.najviseKljuceva) this.#pocisti(now);
    for (const kljuc of kljucevi) this.#mapa.set(kljuc, [...(this.#mapa.get(kljuc) ?? []), now]);
    let otpusteno = false;
    return {
      dopusteno: true,
      otpusti: () => {
        if (otpusteno) return;
        otpusteno = true;
        for (const kljuc of kljucevi) {
          const sve = this.#mapa.get(kljuc);
          const i = sve?.indexOf(now) ?? -1;
          if (i !== -1) sve.splice(i, 1);
          if (sve && sve.length === 0) this.#mapa.delete(kljuc);
        }
      },
    };
  }

  get velicina() {
    return this.#mapa.size;
  }
}
