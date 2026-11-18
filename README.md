# Aplication_server

Aplikacijski poslužitelj Ducture: Next.js (App Router) na Node.js, JavaScript bez TypeScripta. CI (`.github/workflows/ci.yml`) na svakom PR-u radi install, `pnpm audit`, lint, test i build; workflow je zaključan testom `test/ci-workflow.test.mjs`. Docker sliku i Kubernetes manifeste dodaju sljedeći PR-ovi zadatka DAN-1103; svaki PR prolazi review i QA prije spajanja.

## Zahtjevi

- Node.js LTS 24 (od 24.11) ili 26; CI uzima najnoviji Node koji zadovoljava `engines`.
- pnpm u verziji iz polja `packageManager` u `package.json` (Node 26 nema corepack: `npm install --global pnpm@<verzija>`).

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

`GET /api/health` vraća `200` i `{"status":"ok"}` uz `Cache-Control: no-store`. Odgovor je namjerno uvijek isti: nema vremena, verzije, okoline ni tajni. `HEAD` vraća `200`, `OPTIONS` `204`, a `POST`, `PUT`, `PATCH` i `DELETE` `405`; svi s `Allow: GET, HEAD, OPTIONS`. Na tu rutu će se oslanjati `HEALTHCHECK` u Docker slici i probe u Kubernetesu.

## Pravila

- Samo JavaScript: nema `.ts`/`.tsx` datoteka, `tsconfig` ni koraka typecheck; to provjerava `test/javascript-only.test.mjs`.
- Nema tajni u repozitoriju; `.env` datoteke su u `.gitignore`.
