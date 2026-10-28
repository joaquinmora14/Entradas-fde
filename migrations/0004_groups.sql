-- Grupos: la gente pide entradas en grupo (un mensaje con varias personas que van juntas).
-- Las personas cargadas juntas a "fuera de lista" forman un grupo, y las entradas anotadas
-- juntas (una lista pegada o un grupo elegido de la lista) también.

-- Pool: las personas ya cargadas se agrupan por carga (mismo egresado, misma transacción).
ALTER TABLE app.pool_people ADD COLUMN group_id uuid;
UPDATE app.pool_people p
   SET group_id = g.gid
  FROM (
    SELECT added_by, added_at, gen_random_uuid() AS gid
      FROM app.pool_people
     GROUP BY added_by, added_at
  ) g
 WHERE p.added_at = g.added_at AND p.added_by IS NOT DISTINCT FROM g.added_by;
ALTER TABLE app.pool_people ALTER COLUMN group_id SET DEFAULT gen_random_uuid();
ALTER TABLE app.pool_people ALTER COLUMN group_id SET NOT NULL;
CREATE INDEX pool_group_idx ON app.pool_people (group_id, seq);

-- Invitaciones: cada invitación existente queda como su propio grupo (el valor por
-- defecto se calcula fila por fila), salvo las que vinieron del pool, que toman el
-- grupo de la persona elegida.
ALTER TABLE app.invitations ADD COLUMN group_id uuid NOT NULL DEFAULT gen_random_uuid();
UPDATE app.invitations i
   SET group_id = p.group_id
  FROM app.pool_people p
 WHERE p.invitation_id = i.id AND i.group_id <> p.group_id;
CREATE INDEX invitations_group_idx ON app.invitations (group_id);
