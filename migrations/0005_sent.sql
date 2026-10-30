-- "Ya la mandé": el egresado marca qué invitaciones ya envió, para no perderse.
-- Es solo una marca personal: no cambia el cupo, la planilla ni nada más.
ALTER TABLE app.invitations ADD COLUMN sent_at timestamptz;
