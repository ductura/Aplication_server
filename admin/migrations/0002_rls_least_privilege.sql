-- DAN-1531: row level security on admin.platform_admin and read-only access
-- for the application role (attack plan on ductura/Aplication_server#15).
-- 0001 stays as it was applied.
--
-- The web server only checks a password at login, so ductura_app may read
-- the table and nothing else. An admin is created or given a new password
-- only by `pnpm admin:stvori`, which runs as the owner (DATABASE_OWNER_URL).
-- The role is the same one institutions/migrations/0004 creates; whichever
-- folder runs first creates it.
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

REVOKE ALL ON SCHEMA admin FROM PUBLIC;
REVOKE ALL ON admin.platform_admin FROM PUBLIC;
GRANT USAGE ON SCHEMA admin TO ductura_app;

ALTER TABLE admin.platform_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin.platform_admin FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_admin_owner ON admin.platform_admin FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

GRANT SELECT ON admin.platform_admin TO ductura_app;
CREATE POLICY platform_admin_app_read ON admin.platform_admin FOR SELECT TO ductura_app USING (true);
