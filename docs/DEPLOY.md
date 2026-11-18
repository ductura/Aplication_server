# Objava: Render

Aplication_server ide na **Render** kao Docker web usluga s vlastitom bazom PostgreSQL. Na Vercelu nije: treba mu stalna veza na bazu i migracije prije pokretanja. Preglednik ga nikad ne zove izravno. Zove ga samo BFF Aplication_fronta, s poslužitelja, na adresi iz `APLICATION_SERVER_URL`.

## Datoteke

- `Dockerfile`: višefazna produkcijska slika. Koristi istu baznu sliku Node 24 kao Institution_server (prikvačenu digestom), radi kao korisnik `node`, a `next start` sluša na `$PORT` (zadano 3110, Render postavlja svoj). Ima `HEALTHCHECK` na `GET /api/health`. U slici nema tajni ni vrijednosti varijabli. Uz build su u slici `admin/`, `institutions/` i `lib/`, pa se `pnpm db:migrate` i `pnpm admin:stvori` mogu pokrenuti i u kontejneru.
- `.dockerignore`: `.git`, `node_modules`, `.next`, `.local/`, `test/` i sve `.env*` datoteke ne ulaze u kontekst gradnje.
- `render.yaml`: Blueprint s web uslugom `ductura-aplication-server` (regija frankfurt, Docker, health check `/api/health`) i bazom `ductura-aplication-db` (PostgreSQL 17). Plan nije zadan, pa ga biraš u Renderu.

## Varijable okoline

| Ime | Odakle | Napomena |
| --- | --- | --- |
| `DATABASE_URL` | Render, iz baze `ductura-aplication-db` | postavlja se samo |
| `INSTITUTION_SERVER_URL` | ručno | https adresa Institution_servera bez putanje, npr. `https://ductura-institution-server.onrender.com` |
| `DUCTURA_PROVISIONING_TOKEN` | ručno | ista vrijednost kao na Institution_serveru, najmanje 32 znaka |
| `DUCTURA_ADMIN_TOKEN_SECRET` | ručno | najmanje 32 znaka; promjena poništava sve admin sesije |

`NODE_ENV=production` je u slici, pa kolačić `ductura_admin` dobiva `Secure`.

Tajne generiraš lokalno: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Nikad ih ne upisuj u repo.

## Gradnja i provjera lokalno

```sh
docker build -t aplication-server .
docker run --rm -p 3110:3110 -e DATABASE_URL=... aplication-server
curl http://127.0.0.1:3110/api/health    # {"status":"ok"}
```

## Što Daniel radi ručno

1. U Renderu: **New → Blueprint**, repo `ductura/Aplication_server`, grana `main`. Render pročita `render.yaml` i pita za tri varijable sa `sync: false`.
2. Bira plan usluge i baze. `preDeployCommand` (migracije prije svakog deploya) radi samo na plaćenom planu. Na besplatnom migracije pokreneš ručno iz Shella usluge: `node institutions/migrate.js && node admin/migrate.js`.
3. Prvi administrator: iz Shella usluge `node admin/stvori.js <ime>`. Lozinku upisuješ tamo, ne u repo ni u varijable.
4. Adresu usluge upisuješ u `APLICATION_SERVER_URL` Aplication_fronta na Vercelu.

## Poznato

- Ograničenje prijave po IP-u čita zadnji unos `X-Forwarded-For`. Iza lanca ductura.org (Vercel) → Aplication_front → Aplication_server to nije adresa korisnika. Ograničenje po korisničkom imenu i dalje radi. Ispravak je zaseban zadatak.
- Postavljanje usluge i baze, registry i deploy nisu dio ovog PR-a.
