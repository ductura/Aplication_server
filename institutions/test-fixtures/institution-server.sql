-- Test fixture only: the part of ductura/Institution_server's main database
-- that the provisioner writes, copied from its migrations (main at the time
-- of writing):
--   20261003210100_identity_session.sql         identity.institution
--   20261010210000_open_session.sql             identity.institution.aai_home_org
--   20261101010000_institution_issuer.sql       identity.institution_issuer
--   20261010180000_institution_model.sql        institution.institution_settings
--   20261018130000_institution_plain_label_marks.sql  institution.is_plain_label
-- Roles, RLS and the functions around these tables are left out: the
-- provisioner connects as the operator, as seeds and provisioning do there.
CREATE SCHEMA identity;
CREATE SCHEMA institution;

CREATE TABLE identity.institution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,32}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identity.institution
  ADD COLUMN aai_home_org text UNIQUE CHECK (
    char_length(aai_home_org) <= 253
    AND aai_home_org ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  );

CREATE TABLE identity.institution_issuer (
  institution_id uuid NOT NULL REFERENCES identity.institution (id),
  oidc_issuer text NOT NULL CHECK (
    char_length(oidc_issuer) <= 255
    AND oidc_issuer ~ ('^https?://[!-~]+$' COLLATE "C")
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, oidc_issuer)
);

CREATE FUNCTION institution.is_plain_label(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT length(p_text) BETWEEN 1 AND 200
     AND p_text !~ '[\x0001-\x001F\x007F-\x009F\x00AD\x034F\x061C\x180E\x200B-\x200F\x2028-\x202E\x2060-\x206F\xFEFF\xFFF9-\xFFFB\U000E0000-\U000E007F]'
     AND p_text ~ '[^\s\x00A0\x034F\x115F\x1160\x1680\x17B4\x17B5\x180B-\x180D\x2000-\x200A\x202F\x205F\x2800\x3000\x3164\xFE00-\xFE0F\xFFA0\U000E0000-\U000E0FFF]'
$$;

CREATE TABLE institution.institution_settings (
  institution_id uuid PRIMARY KEY REFERENCES identity.institution (id),
  display_name text NOT NULL CHECK (institution.is_plain_label(display_name)),
  enrollment_attempt_limit integer NOT NULL DEFAULT 5 CHECK (enrollment_attempt_limit BETWEEN 1 AND 100),
  enrollment_attempt_window interval NOT NULL DEFAULT '15 minutes'
    CHECK (enrollment_attempt_window BETWEEN '1 minute' AND '24 hours'
           AND extract(day FROM enrollment_attempt_window) = 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
