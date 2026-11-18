-- The provisioner (institutions/podigni.js) records every attempt on the
-- request, so a request stuck in u_izradi shows why. The state rules and the
-- frozen payload of 0001 are unchanged.
ALTER TABLE institutions.instance_provisioning
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error text CHECK (char_length(last_error) <= 2000);
