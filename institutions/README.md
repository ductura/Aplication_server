# Institucije

Mapa `institutions/` u PostgreSQL-u aplikacijskog poslužitelja čuva sve što treba da se za jednu instituciju podigne instanca na Institution_serveru. Jedna institucija je jedan fakultet Sveučilišta u Zagrebu.

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
- `admin.js`: vrata za admin rute.

## Tablice

- `institutions.institution`: fakultet, naziv, slug, AAI domena (`hrEduPersonHomeOrg`, mala slova), OIDC issuer, postavke upisa i vrijeme stvaranja. Fakultet i AAI domena su jedinstveni.
- `institutions.account`: računi po ulozi (`student`, `teacher`, `institution_admin`, `network_engineer`), zadani brojem. Račun je mjesto bez lozinke. Uz osobu se veže pri prvoj prijavi preko AAI@EduHr (D-09), funkcijom `institutions.bind_account(institucija, uloga, issuer, hrEduPersonUniqueID)`. Ona uzima najniže slobodno mjesto te uloge, a ista osoba dobiva isto mjesto. Mrežni inženjer ima `requires_fido2`. `app_admin` je na razini države i ovdje nema računa.
- `institutions.instance_provisioning`: zahtjev za instancu. Stanje ide samo naprijed, `zatrazena` → `u_izradi` → `aktivna`. `payload` se ne mijenja i sadrži `slug`, `display_name`, `aai_home_org`, `oidc_issuer`, postavke, broj računa i prvog admina institucije (`first_admin.account_id`).

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

## HTTP

`POST /api/admin/institutions` prima JSON s istim poljima i vraća `201`. Na isti fakultet ili istu domenu vraća `409`, a na neispravan unos `400`. `GET /api/admin/institutions` vraća popis sa stanjem zahtjeva i brojem računa po ulozi.

**TODO (admin sesija):** u `main` još nema admin sesije (DAN-1104). Do tada su rute zatvorene: bez `INSTITUTIONS_ADMIN_TOKEN` (najmanje 32 znaka) u okolini poslužitelja vraćaju `503`, a bez točnog `Authorization: Bearer` tokena `401`. To je ključ operatera za API, ne način prijave osobe.

## Testovi

- `pnpm test` (`test/institutions.test.mjs`) radi bez baze.
- `pnpm test:db` (`test/institutions-db.test.mjs`) radi nad pravim PostgreSQL-om iz `DATABASE_URL`. Ime baze mora sadržavati `test`, jer test briše i ponovno stvara shemu `institutions`. Bez `DATABASE_URL` test pada, ne preskače se. U CI-ju ga pokreće posao `db` sa `services: postgres`.
