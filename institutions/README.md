# Institucije

Mapa `institutions/` u PostgreSQL-u aplikacijskog poslužitelja čuva sve što treba da se za jednu instituciju podigne instanca na Institution_serveru. S Institution_serverom razgovara isključivo preko HTTP-a (ugovor Ductus#2028 c.6993786629 §2); pristupa njegovoj bazi nema. Jedna institucija je jedan fakultet Sveučilišta u Zagrebu.

Model je preuzet iz `ductura/Institution_server`, ne izmišljen:

| Ovdje | Institution_server |
| --- | --- |
| `institution.slug` (`^[a-z0-9-]{2,32}$`) | `identity.institution.slug` (`*identity_session.sql`) |
| `institution.aai_home_org` | `identity.institution.aai_home_org` (`*open_session.sql`) |
| `institution.oidc_issuer` | `identity.institution_issuer` (`*institution_issuer.sql`) |
| `institution.display_name`, `enrollment_attempt_*` | `institution.institution_settings` (`*institution_model.sql`) |
| `account.role` | vrste računa iz `docs/account-permissions.md` |

## Datoteke

- `data/fakulteti.json`: 32 fakulteta kako ih navodi [unizg.hr](https://www.unizg.hr/o-sveucilistu/sastavnice-sveucilista/fakulteti/) (preuzeto 18. 11. 2026.). `id` je prva oznaka domene weba fakulteta i postaje slug.
- `migrations/*.sql`: shema `institutions`. `pnpm db:migrate` primjenjuje ih redom, svaku u svojoj transakciji, pod advisory lockom. Primijenjena migracija kojoj se promijeni sadržaj zaustavlja pokretanje.
- `stvori.js`: `stvoriInstituciju({fakultetId, aaiDomena, racuni, issuer?})` i `popisInstitucija()`.
- `podigni.js`: HTTP klijent za Institution_server: `podigniInstance({pool, klijent, institutionId?})`, `podigniNakonStvaranja(id)` i `pnpm instance:podigni`.
- `admin.js`: vrata za admin rute.
- `test-fixtures/lazni-institution-server.js`: samo za testove, lažni Institution_server s rutom `POST /internal/v1/institutions`.

## Tablice

- `institutions.institution`: fakultet, naziv, slug, AAI domena (`hrEduPersonHomeOrg`, mala slova), OIDC issuer, postavke upisa i vrijeme stvaranja. Fakultet i AAI domena su jedinstveni.
- `institutions.account`: računi po ulozi (`student`, `teacher`, `institution_admin`, `network_engineer`), zadani brojem. Račun je mjesto bez lozinke. Uz osobu se veže pri prvoj prijavi preko AAI@EduHr (D-09), funkcijom `institutions.bind_account(institucija, uloga, issuer, hrEduPersonUniqueID)`. Ona uzima najniže slobodno mjesto te uloge, a ista osoba dobiva isto mjesto. Mrežni inženjer ima `requires_fido2`. `app_admin` je na razini države i ovdje nema računa.
- `institutions.instance_provisioning`: zahtjev za instancu. Stanje ide samo naprijed, `zatrazena` → `u_izradi` → `aktivna` ili `greska`. `payload` se ne mijenja i sadrži `slug`, `display_name`, `aai_home_org`, `oidc_issuer`, postavke, broj računa po ulozi (`accounts`) i prvog admina institucije (`first_admin.account_id`). Uz zahtjev se vode `attempts`, `last_attempt_at`, `last_error`, `institution_server_id` (samo za `aktivna`) i `error_code` (samo za `greska`).

## Stvaranje

`stvoriInstituciju` provjerava ulaz prije prvog upita i zatim u jednoj transakciji upisuje instituciju, račune i zahtjev za instancu. Primjer s 200 studenata, 50 nastavnika, 3 mrežna inženjera i 1 adminom institucije:

```js
await stvoriInstituciju({
  fakultetId: "fpzg",
  aaiDomena: "fpzg.hr",
  racuni: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
});
```

- `institution_admin` mora biti od 1 do 20, `student` do 50 000, `teacher` do 5000, a `network_engineer` do 20.
- Issuer se uzima iz `issuer` ili iz varijable okoline `AAI_OIDC_ISSUER`. Stvarni issuer AAI@EduHr ovdje nije zapisan.

## Podizanje instance

Za svaki zahtjev u stanju `zatrazena`, ili `u_izradi` od ranijeg neuspjelog pokušaja, provisioner ga prebacuje u `u_izradi` i šalje:

```
POST {INSTITUTION_SERVER_URL}/internal/v1/institutions
Authorization: Bearer {DUCTURA_PROVISIONING_TOKEN}

{ "slug": "fpzg", "displayName": "Fakultet političkih znanosti",
  "aaiHomeOrg": "fpzg.hr", "oidcIssuer": "http://localhost:8090",
  "seats": { "student": 200, "teacher": 50, "network_engineer": 3, "institution_admin": 1 } }
```

Brojevi računa (`seats`) uzimaju se iz `payload.accounts` zahtjeva. Vrijeme čekanja je 10 s, a preusmjeravanja se ne slijede.

| Odgovor Institution_servera | Stanje zahtjeva |
| --- | --- |
| `201` ili `200` s `institutionId` za taj slug | `aktivna`, `institution_server_id` = `institutionId` |
| `409` (`slug_zauzet`, `domena_zauzeta`) ili `400` (`neispravan_unos`) | `greska`, kod u `error_code`; konačno, ne ponavlja se |
| `401`, `5xx`, drugi status, mrežna greška ili istek vremena | ostaje `u_izradi` s razlogom u `last_error`; sljedeće pokretanje ponavlja |

- Odmah nakon uspješnog `POST /api/admin/institutions` poslužitelj jednom pokušava podići tu instancu i u odgovoru `201` vraća stanje (`provisioning.stanje`, `institutionServerId`, `kodGreske`, `zadnjaGreska`). Institucija je stvorena i kad Institution_server odbije ili ne odgovori.
- `pnpm instance:podigni` ručno ponavlja sve zahtjeve u `zatrazena` i `u_izradi`. Izlaz je `1` ako ijedan nije došao do `aktivna`.
- Isti zahtjev ne šalju dva pokretanja istodobno (advisory lock po zahtjevu); zahtjev koji upravo podiže drugo pokretanje se preskače. Institution_server je idempotentan (`200` za iste podatke), pa ponovljeni zahtjev nije štetan.
- Bez `INSTITUTION_SERVER_URL` (http ili https) i `DUCTURA_PROVISIONING_TOKEN` (najmanje 32 znaka) zahtjev ostaje `zatrazena`, a `pnpm instance:podigni` pada s porukom. Token je zajednička tajna s Institution_serverom; lokalno se generira i nikad ne upisuje u repo (primjer u `.env.example`).

Prvog admina institucije operater imenuje na Institution_serveru nakon prve prijave te osobe preko AAI@EduHr, pa ostaje u `payload.first_admin` i ne šalje se.

## HTTP

`POST /api/admin/institutions` prima JSON s istim poljima i vraća `201`. Na isti fakultet ili istu domenu vraća `409`, a na neispravan unos `400`. `GET /api/admin/institutions` vraća popis sa stanjem zahtjeva i brojem računa po ulozi.

**TODO (admin sesija):** u `main` još nema admin sesije (DAN-1104). Do tada su rute zatvorene: bez `INSTITUTIONS_ADMIN_TOKEN` (najmanje 32 znaka) u okolini poslužitelja vraćaju `503`, a bez točnog `Authorization: Bearer` tokena `401`. To je ključ operatera za API, ne način prijave osobe.

## Testovi

- `pnpm test` (`test/institutions.test.mjs`) radi bez baze.
- `pnpm test` uključuje i `test/institutions-podigni.test.mjs`: HTTP klijent protiv lažnog Institution_servera (201, 200, 409, 400, 401, 5xx, prekid veze i istek vremena), bez baze.
- `pnpm test:db` (`test/institutions-db.test.mjs`, `test/institutions-podigni-db.test.mjs`) radi nad pravim PostgreSQL-om iz `DATABASE_URL` i lažnim Institution_serverom. Ime baze mora sadržavati `test`, jer test briše i ponovno stvara shemu `institutions`. Bez `DATABASE_URL` test pada, ne preskače se. U CI-ju ga pokreće posao `db` sa `services: postgres`.
