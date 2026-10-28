-- Elegir a alguien del pool ("fuera de lista") ahora gasta una entrada individual
-- del egresado, igual que una invitación directa.
CREATE OR REPLACE FUNCTION app.invitations_before() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVITATION_DELETE_FORBIDDEN' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'INVITATION_MUST_START_ACTIVE' USING ERRCODE = 'P0001';
    END IF;
    PERFORM app.lock_email(NEW.guest_email_normalized);
    UPDATE app.invitation_quotas
       SET used = used + 1, updated_at = now()
     WHERE user_id = NEW.inviter_id AND used < initial_quota;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.guest_email_normalized <> OLD.guest_email_normalized
     OR NEW.guest_email <> OLD.guest_email
     OR NEW.inviter_id <> OLD.inviter_id
     OR NEW.source <> OLD.source
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'INVITATION_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status = 'active' THEN
    RAISE EXCEPTION 'INVITATION_CANNOT_REACTIVATE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'cancelled' THEN
    UPDATE app.invitation_quotas
       SET used = used - 1, updated_at = now()
     WHERE user_id = OLD.inviter_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Recalcula el cupo usado con la regla nueva (invitaciones activas de cualquier origen).
-- Si algún egresado quedara por encima de su cupo, la restricción used <= initial_quota
-- hace fallar la migración completa en vez de dejar datos inconsistentes.
UPDATE app.invitation_quotas q
   SET used = sub.n, updated_at = now()
  FROM (
    SELECT q2.user_id, count(i.id) AS n
      FROM app.invitation_quotas q2
      LEFT JOIN app.invitations i ON i.inviter_id = q2.user_id AND i.status = 'active'
     GROUP BY q2.user_id
  ) sub
 WHERE sub.user_id = q.user_id AND q.used <> sub.n;
