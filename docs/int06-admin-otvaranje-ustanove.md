# INT-06 · Otvaranje ustanove i provjera spremnosti

Sistemski test šalje HTTP zahtjeve stvarnom Next.js poslužitelju `Aplication_server` i stvarnom `Institution_server` iz lokalnog stoga INT-01. Priprema sintetički katalog s jednom ustanovom u privremenoj kopiji aplikacije pod `.local/`. Svako pokretanje dobiva jedinstvenu oznaku ustanove, domenu pod `.example.invalid`, administratora platforme i generiranu lozinku.

## Pokretanje na lokalnom ili CI stogu

1. U `Institution_server` podigni svjež testni stog prema uputama `docs/lokalno/STOG.md` (`pnpm stog:gore`). Pokreni `pnpm stog:zdravlje`. Potrebni su Institution_server na `127.0.0.1:4000`, simulator AAI@EduHr s issuerom `http://localhost:8090` i datoteka `.local/provisioning-token` iz istog pokretanja.
2. Pripremi zasebnu praznu PostgreSQL bazu `ductura_int06_test` na loopback adresi. Možeš upotrijebiti sufiks za pojedini posao, primjerice `ductura_int06_test_123`. U URL-u zadaj korisnika i port. Korisnik treba moći primijeniti migracije i upisati podatke u tu bazu. Sistemski test primjenjuje migracije za Aplication_server.
3. U `Aplication_server` instaliraj ovisnosti (`pnpm install --frozen-lockfile`), zadaj `INT06_DATABASE_URL` za tu bazu i `INT06_PROVISIONING_TOKEN_FILE` s putanjom do datoteke iz prvog koraka pa pokreni test.

   ```sh
   node --test scripts/lokalno/admin-otvaranje-ustanove-e2e.test.mjs
   ```

Test pokreće Aplication_server na slobodnom loopback portu. Po završetku gasi taj proces i briše privremenu kopiju. Sintetički retci ostaju u dvjema testnim bazama do uklanjanja testnog stoga. Zapisi su jedinstveni po pokretanju pa ne blokiraju ponavljanje testa.

Postojeći CI ovog repozitorija pokreće `pnpm test` i `pnpm test:db` prema zaključanom popisu skripti i podiže samo PostgreSQL. Za CI prolaz INT-06, posao koji podigne oba poslužitelja i simulator nakon provjere zdravlja mora pozvati gornju naredbu uz iste dvije varijable okoline.

## Prihvaćanje

1. Upit Institution_serveru za novi slug vraća `404`. Pokušaj stvaranja kroz Aplication_server bez administratorske sesije vraća `401`.
2. Administrator platforme prijavljuje se na `/api/admin/prijava` i dobiva sesijski kolačić. Uz taj kolačić katalog vraća izmišljeni fakultet, a `POST /api/admin/institutions` vraća `201`, stanje `aktivna` i ID instance.
3. Zaseban upit `GET /internal/v1/institutions/{slug}` na Institution_serveru vraća isti ID, stanje `aktivna`, isti naziv, domenu, lokalni issuer i kvote svih četiriju uloga.
4. Ponovno čitanje administratorskog popisa potvrđuje da su stanje `aktivna` i ID instance spremljeni.
