# Aplication_server

Aplikacijski poslužitelj Ducture: Next.js (App Router) na Node.js, JavaScript bez TypeScripta. CI (`.github/workflows/ci.yml`) na svakom PR-u radi install, `pnpm audit`, lint, test i build; workflow je zaključan testom `test/ci-workflow.test.mjs`. Docker sliku i Kubernetes manifeste dodaju sljedeći PR-ovi zadatka DAN-1103; svaki PR prolazi review i QA prije spajanja.

## Zahtjevi

- Node.js LTS 24 (od 24.11) ili 26; CI uzima najnoviji Node koji zadovoljava `engines`.
- pnpm u verziji iz polja `packageManager` u `package.json` (Node 26 nema corepack: `npm install --global pnpm@<verzija>`).

## Naredbe

| Naredba | Što radi |
| --- | --- |
| `pnpm install` | instalira ovisnosti prema `pnpm-lock.yaml` |
| `pnpm dev` | razvojni poslužitelj na `http://localhost:3110` (`pnpm start` na istom portu) |
| `pnpm lint` | ESLint (flat config, bez upozorenja) |
| `pnpm test` | testovi kroz `node --test` |
| `pnpm build` | produkcijski build |
| `pnpm start` | pokreće produkcijski build |
| `pnpm db:migrate` | primjenjuje migracije iz `institutions/migrations` i `admin/migrations` na bazu iz `DATABASE_URL` |
| `pnpm instance:podigni` | ponovno šalje zatražene instance Institution_serveru preko HTTP-a (`INSTITUTION_SERVER_URL`, `DUCTURA_PROVISIONING_TOKEN`) |
| `pnpm test:db` | testovi institucija i admina nad pravim PostgreSQL-om (`DATABASE_URL` na testnu bazu) |
| `pnpm admin:stvori <ime> [--zamijeni]` | stvara administratora platforme (ili mu postavlja novu lozinku); lozinka se čita sa stdin |

## Provjera zdravlja

`GET /api/health` vraća `200` i `{"status":"ok"}` uz `Cache-Control: no-store`. Odgovor je namjerno uvijek isti: nema vremena, verzije, okoline ni tajni. `HEAD` vraća `200` (daje ga Next iz `GET`). `OPTIONS` vraća `204`, a `POST`, `PUT`, `PATCH` i `DELETE` `405`, oba sa zaglavljem `Allow: GET, HEAD, OPTIONS`. Ponašanje kroz pokrenuti server provjerava `test/server.test.mjs` u sklopu `pnpm build`. Na tu rutu će se oslanjati `HEALTHCHECK` u Docker slici i probe u Kubernetesu.

## Institucije

Mapa [`institutions/`](institutions/README.md) čuva fakultete, račune po ulozi i zahtjeve za instancu na Institution_serveru. Rute su `POST` i `GET /api/admin/institutions`. Instanca se podiže samo preko HTTP-a (`POST /internal/v1/institutions` na Institution_serveru); Aplication_server nema pristup bazi Institution_servera. Varijable okoline su u [`.env.example`](.env.example).

## Administrator platforme

Administrator platforme prijavljuje se korisničkim imenom i lozinkom (ugovor Ductus#2028 c.6993786629 §3.4). Svi računi institucija prijavljuju se samo preko AAI@EduHr (D-09, D-16).

- Tablica `admin.platform_admin` (`admin/migrations/`): `korisnicko_ime` normalizirano (trim, mala slova, `^[a-z0-9._-]{3,40}$`), `lozinka_hash` argon2id (PHC, `node:crypto`), `stvoreno`.
- `POST /api/admin/prijava` `{korisnickoIme, lozinka}`: samo `application/json`, najviše 4 KB. Krivo ime, kriva lozinka i nepoznata polja daju isti `401 {"greska":"prijava_neuspjesna"}`; hash se provjerava i kad ime ne postoji. Najviše 5 pokušaja u 15 minuta po imenu i po IP-u (zadnji unos `X-Forwarded-For`, dakle onaj koji je dodao edge proxy), zatim `429` i `Retry-After`. Uspjeh vraća `200 {korisnickoIme}` i kolačić `ductura_admin` (HttpOnly, SameSite=Strict, Path=/, 8 h, `Secure` kad je `NODE_ENV=production`).
- `POST /api/admin/odjava` briše kolačić (`204`). `GET /api/admin/ja` vraća `{korisnickoIme}` ili `401`.
- Token je potpisan HMAC-SHA256 tajnom iz `DUCTURA_ADMIN_TOKEN_SECRET` (najmanje 32 znaka). Bez nje prijava vraća `503`. Promjena tajne poništava sve sesije.
- Čuvar za rute administratora je `adminIzZahtjeva(request)` iz `lib/admin-sesija.js`. Iza njega su `GET`/`POST /api/admin/institutions` i `GET /api/admin/fakulteti` (`200 {"fakulteti":[{id, naziv, web}]}`, popis za obrazac).

Lokalno (lozinka nikad u repo, log ni argumente; `.local/` je u `.gitignore`):

```sh
export DATABASE_URL=postgres://localhost:5432/ductura
export DUCTURA_ADMIN_TOKEN_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
pnpm db:migrate
pnpm admin:stvori daniel   # pita lozinku dvaput, bez prikaza; najmanje 12 znakova
pnpm dev                   # http://localhost:3110
```

## Pravila

- Samo JavaScript: nema `.ts`/`.tsx` datoteka, `tsconfig` ni koraka typecheck; to provjerava `test/javascript-only.test.mjs`.
- Nema tajni u repozitoriju; `.env` datoteke su u `.gitignore`, osim `.env.example` bez vrijednosti tajni.
