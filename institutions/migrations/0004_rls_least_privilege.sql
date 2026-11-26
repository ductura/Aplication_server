-- DAN-1531: row level security on every institutions table and a role of
-- least privilege for the application (attack plan on
-- ductura/Aplication_server#15). 0001..0003 stay as they were applied.
--
-- ductura_app is what the web server and `pnpm instance:podigni` run as
-- (institutions/db.js switches every connection to it). It gets only what
-- that code does: read everything, create an institution with its seats and
-- its request, and move a pending request forward. It never updates an
-- institution, never binds or changes a seat, never deletes or truncates.
-- The owner of the tables (whoever runs `pnpm db:migrate`) keeps full access
-- through its own policies, because RLS is forced on it too.
DO $$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'ductura_app';
  IF NOT FOUND THEN
    CREATE ROLE ductura_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'role ductura_app must not be superuser, bypass RLS, create roles or databases, or replicate';
  END IF;
END
$$;

REVOKE ALL ON SCHEMA institutions FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA institutions FROM PUBLIC;
GRANT USAGE ON SCHEMA institutions TO ductura_app;

-- Binding a seat to a person happens at the first AAI@EduHr login (D-09), not
-- from this application today; nobody but the owner may call it.
REVOKE EXECUTE ON FUNCTION institutions.bind_account(uuid, text, text, text) FROM PUBLIC;

ALTER TABLE institutions.institution ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions.institution FORCE ROW LEVEL SECURITY;
ALTER TABLE institutions.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions.account FORCE ROW LEVEL SECURITY;
ALTER TABLE institutions.instance_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions.instance_provisioning FORCE ROW LEVEL SECURITY;

-- Owner: maintenance and later migrations.
CREATE POLICY institution_owner ON institutions.institution FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY account_owner ON institutions.account FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY provisioning_owner ON institutions.instance_provisioning
  FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- institution: the platform admin's list and detail, and a new institution.
GRANT SELECT, INSERT ON institutions.institution TO ductura_app;
CREATE POLICY institution_app_read ON institutions.institution FOR SELECT TO ductura_app USING (true);
CREATE POLICY institution_app_create ON institutions.institution FOR INSERT TO ductura_app WITH CHECK (true);

-- account: seats are created free, and only while the institution has no
-- request yet; the request freezes the seat counts it sends to
-- Institution_server (0001), so a seat added later would never exist there.
GRANT SELECT, INSERT ON institutions.account TO ductura_app;
CREATE POLICY account_app_read ON institutions.account FOR SELECT TO ductura_app USING (true);
CREATE POLICY account_app_create ON institutions.account FOR INSERT TO ductura_app
  WITH CHECK (
    bound_at IS NULL AND oidc_issuer IS NULL AND hr_edu_person_unique_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM institutions.instance_provisioning p WHERE p.institution_id = account.institution_id
    )
  );

-- instance_provisioning: a request is created fresh, and only a pending one
-- (zatrazena, u_izradi) moves forward. aktivna and greska are final for the
-- application. The payload, the institution and requested_at cannot be
-- written at all (column grants); the trigger still checks the state order.
GRANT SELECT, INSERT ON institutions.instance_provisioning TO ductura_app;
GRANT UPDATE (state, attempts, last_attempt_at, activated_at, institution_server_id, error_code, last_error)
  ON institutions.instance_provisioning TO ductura_app;
CREATE POLICY provisioning_app_read ON institutions.instance_provisioning FOR SELECT TO ductura_app USING (true);
CREATE POLICY provisioning_app_create ON institutions.instance_provisioning FOR INSERT TO ductura_app
  WITH CHECK (
    state = 'zatrazena' AND attempts = 0 AND last_attempt_at IS NULL AND last_error IS NULL
    AND activated_at IS NULL AND institution_server_id IS NULL AND error_code IS NULL
  );
CREATE POLICY provisioning_app_advance ON institutions.instance_provisioning FOR UPDATE TO ductura_app
  USING (state IN ('zatrazena', 'u_izradi'))
  WITH CHECK (true);
