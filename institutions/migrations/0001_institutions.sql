-- Institutions of the application server (Daniel, 18 Nov 2026): everything
-- needed to raise one institution's instance on Institution_server. One
-- institution is one faculty of the University of Zagreb
-- (institutions/data/fakulteti.json, source unizg.hr).
--
-- The columns follow ductura/Institution_server db/main/migrations:
--   *identity_session.sql     identity.institution (slug ^[a-z0-9-]{2,32}$)
--   *open_session.sql         identity.institution.aai_home_org
--   *institution_issuer.sql   identity.institution_issuer.oidc_issuer
--   *institution_model.sql    institution.institution_settings (display_name,
--                             enrolment limit and window), institution_role
-- and the account kinds from its docs/account-permissions.md.
CREATE SCHEMA institutions;

-- Institution_server's is_plain_label after
-- 20261018130000_institution_plain_label_marks.sql, so a display name stored
-- here always passes its CHECK on institution_settings.display_name.
CREATE FUNCTION institutions.is_plain_label(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT length(p_text) BETWEEN 1 AND 200
     AND p_text !~ '[\x0001-\x001F\x007F-\x009F\x00AD\x034F\x061C\x180E\x200B-\x200F\x2028-\x202E\x2060-\x206F\xFEFF\xFFF9-\xFFFB\U000E0000-\U000E007F]'
     AND p_text ~ '[^\s\x00A0\x034F\x115F\x1160\x1680\x17B4\x17B5\x180B-\x180D\x2000-\x200A\x202F\x205F\x2800\x3000\x3164\xFE00-\xFE0F\xFFA0\U000E0000-\U000E0FFF]'
$$;

-- fakultet_id is unique: one faculty has at most one institution. The slug
-- is the faculty id today, but stays its own column because Institution_server
-- keys everything on it. aai_home_org is hrEduPersonHomeOrg in the lower-case
-- spelling open_session compares against; the issuer is the OIDC issuer the
-- instance records in identity.institution_issuer.
CREATE TABLE institutions.institution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fakultet_id text NOT NULL UNIQUE CHECK (fakultet_id ~ '^[a-z0-9-]{2,32}$'),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,32}$'),
  display_name text NOT NULL CHECK (institutions.is_plain_label(display_name)),
  aai_home_org text NOT NULL UNIQUE CHECK (
    char_length(aai_home_org) <= 253
    AND aai_home_org ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  oidc_issuer text NOT NULL CHECK (
    char_length(oidc_issuer) <= 255
    AND oidc_issuer ~ ('^https?://[!-~]+$' COLLATE "C")
  ),
  -- Settings as in institution.institution_settings, same defaults and bounds.
  enrollment_attempt_limit integer NOT NULL DEFAULT 5 CHECK (enrollment_attempt_limit BETWEEN 1 AND 100),
  enrollment_attempt_window interval NOT NULL DEFAULT '15 minutes'
    CHECK (enrollment_attempt_window BETWEEN '1 minute' AND '24 hours'
           AND extract(day FROM enrollment_attempt_window) = 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An account is a place without a password. It is bound to a person at that
-- person's first login through AAI@EduHr (D-09): identity is the issuer plus
-- hrEduPersonUniqueID, never e-mail (D-73). app_admin is national, not part
-- of an institution, so it has no row here. A network engineer signs in
-- with AAI@EduHr and FIDO2 (docs/account-permissions.md).
CREATE TABLE institutions.account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions.institution (id),
  role text NOT NULL CHECK (role IN ('student', 'teacher', 'institution_admin', 'network_engineer')),
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  requires_fido2 boolean GENERATED ALWAYS AS (role = 'network_engineer') STORED,
  oidc_issuer text CHECK (char_length(oidc_issuer) BETWEEN 1 AND 255),
  hr_edu_person_unique_id text CHECK (char_length(hr_edu_person_unique_id) BETWEEN 1 AND 255),
  bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, role, ordinal),
  -- One person holds at most one account per institution.
  UNIQUE (institution_id, oidc_issuer, hr_edu_person_unique_id),
  CHECK ((oidc_issuer IS NULL) = (hr_edu_person_unique_id IS NULL)
         AND (oidc_issuer IS NULL) = (bound_at IS NULL))
);
CREATE INDEX account_free_idx ON institutions.account (institution_id, role, ordinal)
  WHERE bound_at IS NULL;

-- The request for an instance on Institution_server. payload holds what the
-- instance needs (slug, aai_home_org, issuer, first institution admin,
-- settings, account counts), frozen when the request is made.
CREATE TABLE institutions.instance_provisioning (
  institution_id uuid PRIMARY KEY REFERENCES institutions.institution (id),
  state text NOT NULL DEFAULT 'zatrazena' CHECK (state IN ('zatrazena', 'u_izradi', 'aktivna')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CHECK ((state = 'aktivna') = (activated_at IS NOT NULL))
);

-- State only moves forward, one step at a time: zatrazena -> u_izradi ->
-- aktivna. The payload never changes once requested.
CREATE FUNCTION institutions.provisioning_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.institution_id <> OLD.institution_id
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'provisioning request is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'zatrazena' AND NEW.state = 'u_izradi')
       OR (OLD.state = 'u_izradi' AND NEW.state = 'aktivna')) THEN
    RAISE EXCEPTION 'provisioning state cannot go from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;
CREATE TRIGGER instance_provisioning_guard BEFORE UPDATE ON institutions.instance_provisioning
  FOR EACH ROW EXECUTE FUNCTION institutions.provisioning_guard();

-- First login: bind the person to the lowest free account of the role. The
-- same person again gets the same account. The issuer must be the one
-- recorded for the institution. SKIP LOCKED lets parallel first logins take
-- different accounts instead of waiting on one row.
CREATE FUNCTION institutions.bind_account(
  p_institution_id uuid,
  p_role text,
  p_issuer text,
  p_unique_id text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path = ''
AS $$
DECLARE
  v_issuer text;
  v_account uuid;
  v_role text;
BEGIN
  SELECT i.oidc_issuer INTO v_issuer FROM institutions.institution i WHERE i.id = p_institution_id;
  IF v_issuer IS NULL OR p_issuer IS DISTINCT FROM v_issuer
     OR p_unique_id IS NULL OR char_length(p_unique_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
  END IF;

  SELECT a.id, a.role INTO v_account, v_role FROM institutions.account a
  WHERE a.institution_id = p_institution_id AND a.oidc_issuer = p_issuer
    AND a.hr_edu_person_unique_id = p_unique_id;
  IF v_account IS NOT NULL THEN
    IF v_role <> p_role THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'ZD403';
    END IF;
    RETURN v_account;
  END IF;

  SELECT a.id INTO v_account FROM institutions.account a
  WHERE a.institution_id = p_institution_id AND a.role = p_role AND a.bound_at IS NULL
  ORDER BY a.ordinal
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'no free account' USING ERRCODE = 'ZD409';
  END IF;

  UPDATE institutions.account
  SET oidc_issuer = p_issuer, hr_edu_person_unique_id = p_unique_id, bound_at = pg_catalog.now()
  WHERE id = v_account;
  RETURN v_account;
END
$$;
