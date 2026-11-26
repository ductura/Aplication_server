-- A request in greska can be retried by a signed-in admin
-- (POST /api/admin/institutions/{id}/ponovi, DAN-1532). Until now greska was
-- final: the trigger of 0003 allowed no step out of it, the update policy of
-- 0004 hid it from the application, and fakultet_id is UNIQUE, so the
-- institution could neither be raised again nor created anew.
--
-- The one new step is greska -> u_izradi. error_code goes back to NULL with it
-- (the CHECK of 0003 ties error_code to greska); last_error is kept until the
-- next outcome replaces it. aktivna stays final. Two retries at once are kept
-- apart by the provisioner's advisory lock and its conditional UPDATE
-- (institutions/podigni.js), not by this file.
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
       OR (OLD.state = 'u_izradi' AND NEW.state IN ('aktivna', 'greska'))
       OR (OLD.state = 'greska' AND NEW.state = 'u_izradi')) THEN
    RAISE EXCEPTION 'provisioning state cannot go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;

-- The application may now update a request in greska as well; the trigger
-- above still allows it only the step back to u_izradi. aktivna stays out of
-- reach of the application.
DROP POLICY provisioning_app_advance ON institutions.instance_provisioning;
CREATE POLICY provisioning_app_advance ON institutions.instance_provisioning FOR UPDATE TO ductura_app
  USING (state IN ('zatrazena', 'u_izradi', 'greska'))
  WITH CHECK (true);
