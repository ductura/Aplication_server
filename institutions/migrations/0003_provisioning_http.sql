-- The provisioner now raises an instance only over HTTP (contract on
-- Ductus#2028 c.6993786629 §2): POST /internal/v1/institutions on
-- Institution_server. It has no access to Institution_server's database.
--
-- * institution_server_id: the institutionId Institution_server answered
--   with (201 or 200), kept only on an active request.
-- * greska: Institution_server refused the request for good (409 or 400).
--   error_code is its "greska" code (slug_zauzet, domena_zauzeta,
--   neispravan_unos); last_error keeps the detail. greska is final: it is
--   not retried. A network error, a timeout or a 5xx keeps the request in
--   u_izradi, and the next run retries it.
-- The seat counts per role are taken from payload.accounts, frozen when the
-- request was made (0001).
ALTER TABLE institutions.instance_provisioning
  DROP CONSTRAINT instance_provisioning_state_check,
  ADD CONSTRAINT instance_provisioning_state_check
    CHECK (state IN ('zatrazena', 'u_izradi', 'aktivna', 'greska')),
  ADD COLUMN institution_server_id uuid,
  ADD COLUMN error_code text CHECK (error_code ~ '^[a-z0-9_]{1,64}$'),
  ADD CHECK (institution_server_id IS NULL OR state = 'aktivna'),
  ADD CHECK ((state = 'greska') = (error_code IS NOT NULL));

-- State only moves forward, one step at a time: zatrazena -> u_izradi ->
-- aktivna or greska. The payload never changes once requested.
CREATE OR REPLACE FUNCTION institutions.provisioning_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.institution_id <> OLD.institution_id
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'provisioning request is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'zatrazena' AND NEW.state = 'u_izradi')
       OR (OLD.state = 'u_izradi' AND NEW.state IN ('aktivna', 'greska'))) THEN
    RAISE EXCEPTION 'provisioning state cannot go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
