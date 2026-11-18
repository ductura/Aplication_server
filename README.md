# Aplication_server

Aplikacijski poslužitelj Ducture: Next.js (App Router) na Node.js, JavaScript bez TypeScripta. Docker sliku, Kubernetes manifeste i CI dodaju sljedeći PR-ovi zadatka DAN-1103; svaki PR prolazi review i QA prije spajanja.

## Zahtjevi

- Node.js LTS, najmanje 24.11 (slika i CI koriste Node 26 LTS).
- pnpm u verziji iz polja `packageManager` u `package.json` (najlakše kroz `corepack enable`).

## Naredbe

| Naredba | Što radi |
| --- | --- |
| `pnpm install` | instalira ovisnosti prema `pnpm-lock.yaml` |
| `pnpm dev` | razvojni poslužitelj na `http://localhost:3000` |
| `pnpm lint` | ESLint (flat config, bez upozorenja) |
| `pnpm test` | testovi kroz `node --test` |
| `pnpm build` | produkcijski build |
| `pnpm start` | pokreće produkcijski build |

## Provjera zdravlja

`GET /api/health` vraća `200` i `{"status":"ok"}` uz `Cache-Control: no-store`. Odgovor je namjerno uvijek isti: nema vremena, verzije, okoline ni tajni. Ostale metode dobivaju `405`. Na tu rutu će se oslanjati `HEALTHCHECK` u Docker slici i probe u Kubernetesu.

## Pravila

- Samo JavaScript: nema `.ts`/`.tsx` datoteka, `tsconfig` ni koraka typecheck; to provjerava `test/javascript-only.test.mjs`.
- Nema tajni u repozitoriju; `.env` datoteke su u `.gitignore`.
