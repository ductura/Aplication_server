-- Platform administrators of Ductura (contract Ductus#2028 c.6993786629 §3.4).
-- They sign in to the application server with a user name and a password;
-- nobody of an institution does (D-09, D-16: those sign in only through
-- AAI@EduHr). The password is stored only as an argon2id PHC string.
CREATE SCHEMA admin;

-- korisnicko_ime is stored normalised (trim, lower case), so the primary key
-- also keeps "Ana" and "ana" from being two admins.
CREATE TABLE admin.platform_admin (
  korisnicko_ime text PRIMARY KEY CHECK (korisnicko_ime ~ ('^[a-z0-9._-]{3,40}$' COLLATE "C")),
  lozinka_hash text NOT NULL CHECK (
    char_length(lozinka_hash) <= 200
    AND lozinka_hash ~ ('^\$argon2id\$v=19\$m=[0-9]{1,7},t=[0-9]{1,2},p=[0-9]{1,2}\$[A-Za-z0-9+/]{11,86}\$[A-Za-z0-9+/]{22,86}$' COLLATE "C")
  ),
  stvoreno timestamptz NOT NULL DEFAULT now()
);
