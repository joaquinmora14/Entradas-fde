-- Esquema inicial de la aplicación de invitaciones (fiesta de egresados).
-- Todo vive en el esquema "app", que Supabase NO expone por su API REST pública.

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- Usuarios (egresados autorizados y administradores)
-- status:
--   pending  -> autorizado por el administrador, todavía no creó su contraseña
--   active   -> cuenta registrada
--   disabled -> cuenta deshabilitada por un administrador
-- ---------------------------------------------------------------------------
CREATE TABLE app.users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  display_name   text,
  password_hash  text,
  is_admin       boolean NOT NULL DEFAULT false,
  is_graduate    boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  registered_at  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  CONSTRAINT users_active_has_password CHECK (status <> 'active' OR password_hash IS NOT NULL),
  CONSTRAINT users_display_name_len CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80)
);

CREATE TABLE app.sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON app.sessions (user_id);
CREATE INDEX sessions_expires_idx ON app.sessions (expires_at);

CREATE TABLE app.password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX password_reset_tokens_user_idx ON app.password_reset_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Cupos individuales (16 entradas por egresado).
-- "used" lo mantiene exclusivamente el trigger de invitaciones, dentro de la
-- misma transacción que crea o anula la invitación.
-- ---------------------------------------------------------------------------
CREATE TABLE app.invitation_quotas (
  user_id        uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE RESTRICT,
  initial_quota  integer NOT NULL DEFAULT 16 CHECK (initial_quota >= 0),
  used           integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quota_used_range CHECK (used >= 0 AND used <= initial_quota)
);

-- ---------------------------------------------------------------------------
-- Invitaciones. Un email normalizado solo puede tener UNA invitación activa,
-- sin importar si vino del cupo individual ("direct") o del pool ("pool").
-- Las correcciones administrativas anulan (status = 'cancelled'), nunca borran.
-- ---------------------------------------------------------------------------
CREATE TABLE app.invitations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_email             text NOT NULL,
  guest_email_normalized  text NOT NULL,
  inviter_id              uuid NOT NULL REFERENCES app.users(id) ON DELETE RESTRICT,
  source                  text NOT NULL CHECK (source IN ('direct', 'pool')),
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  cancelled_at            timestamptz,
  cancelled_by            uuid REFERENCES app.users(id) ON DELETE SET NULL,
  cancel_reason           text,
  sync_status             text NOT NULL DEFAULT 'pending'
                          CHECK (sync_status IN ('pending', 'synced', 'error')),
  synced_at               timestamptz,
  CONSTRAINT invitations_email_normalized CHECK (
    guest_email_normalized = lower(btrim(guest_email_normalized))
    AND length(guest_email_normalized) BETWEEN 3 AND 254
  ),
  CONSTRAINT invitations_cancel_consistency CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX invitations_active_email_uq
  ON app.invitations (guest_email_normalized) WHERE status = 'active';
CREATE INDEX invitations_inviter_idx ON app.invitations (inviter_id, created_at DESC);
CREATE INDEX invitations_created_idx ON app.invitations (created_at DESC);
CREATE INDEX invitations_email_idx ON app.invitations (guest_email_normalized);

-- ---------------------------------------------------------------------------
-- Pool común de "Personas fuera de lista".
-- ---------------------------------------------------------------------------
CREATE TABLE app.pool_people (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  email_normalized  text NOT NULL,
  status            text NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available', 'assigned', 'retired')),
  added_at          timestamptz NOT NULL DEFAULT now(),
  added_by          uuid REFERENCES app.users(id) ON DELETE SET NULL,
  assigned_to       uuid REFERENCES app.users(id) ON DELETE RESTRICT,
  invitation_id     uuid UNIQUE REFERENCES app.invitations(id) ON DELETE RESTRICT,
  assigned_at       timestamptz,
  retired_at        timestamptz,
  retired_by        uuid REFERENCES app.users(id) ON DELETE SET NULL,
  retired_reason    text,
  CONSTRAINT pool_email_key UNIQUE (email_normalized),
  CONSTRAINT pool_email_normalized CHECK (
    email_normalized = lower(btrim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 254
  ),
  CONSTRAINT pool_assigned_complete CHECK (
    status <> 'assigned'
    OR (invitation_id IS NOT NULL AND assigned_to IS NOT NULL AND assigned_at IS NOT NULL)
  ),
  CONSTRAINT pool_available_clean CHECK (
    status <> 'available'
    OR (invitation_id IS NULL AND assigned_to IS NULL AND assigned_at IS NULL AND retired_at IS NULL)
  ),
  CONSTRAINT pool_retired_has_date CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);
CREATE INDEX pool_available_fifo_idx ON app.pool_people (added_at, id) WHERE status = 'available';
CREATE INDEX pool_assigned_to_idx ON app.pool_people (assigned_to);

-- ---------------------------------------------------------------------------
-- Outbox transaccional para Google Sheets.
-- Cada alta o anulación de invitación inserta una tarea en la MISMA transacción
-- (vía trigger), así que nunca se pierde aunque el servidor se reinicie.
-- ---------------------------------------------------------------------------
CREATE TABLE app.sheet_sync_jobs (
  id                bigserial PRIMARY KEY,
  invitation_id     uuid NOT NULL REFERENCES app.invitations(id) ON DELETE RESTRICT,
  email_normalized  text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('upsert', 'remove')),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);
CREATE INDEX sheet_sync_jobs_due_idx ON app.sheet_sync_jobs (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX sheet_sync_jobs_invitation_idx ON app.sheet_sync_jobs (invitation_id);

-- Lease para que un solo proceso escriba en la hoja a la vez.
CREATE TABLE app.sync_lease (
  id          integer PRIMARY KEY CHECK (id = 1),
  holder      text,
  expires_at  timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO app.sync_lease (id) VALUES (1);

CREATE TABLE app.sync_runs (
  id            bigserial PRIMARY KEY,
  trigger       text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  ok            boolean,
  jobs          integer NOT NULL DEFAULT 0,
  appended      integer NOT NULL DEFAULT 0,
  removed       integer NOT NULL DEFAULT 0,
  updated       integer NOT NULL DEFAULT 0,
  error         text
);
CREATE INDEX sync_runs_started_idx ON app.sync_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Idempotencia: la misma clave enviada dos veces devuelve el mismo resultado.
-- ---------------------------------------------------------------------------
CREATE TABLE app.idempotency_keys (
  user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  key         uuid NOT NULL,
  action      text NOT NULL,
  response    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
CREATE TABLE app.audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES app.users(id) ON DELETE SET NULL,
  actor_email  text,
  action       text NOT NULL,
  result       text NOT NULL CHECK (result IN ('success', 'rejected', 'error')),
  target       text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON app.audit_logs (created_at DESC);
CREATE INDEX audit_logs_action_idx ON app.audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_actor_email_idx ON app.audit_logs (actor_email, action, created_at DESC);
CREATE INDEX audit_logs_ip_idx ON app.audit_logs (ip, action, created_at DESC);

CREATE TABLE app.settings (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Triggers de consistencia
-- ---------------------------------------------------------------------------

-- Serializa toda operación sobre un mismo email (invitaciones y pool).
CREATE FUNCTION app.lock_email(p_email text) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('guest-email:' || p_email, 0));
$$;

CREATE FUNCTION app.invitations_before() RETURNS trigger
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
    IF NEW.source = 'direct' THEN
      UPDATE app.invitation_quotas
         SET used = used + 1, updated_at = now()
       WHERE user_id = NEW.inviter_id AND used < initial_quota;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'QUOTA_EXCEEDED' USING ERRCODE = 'P0001';
      END IF;
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
  IF OLD.status = 'active' AND NEW.status = 'cancelled' AND OLD.source = 'direct' THEN
    UPDATE app.invitation_quotas
       SET used = used - 1, updated_at = now()
     WHERE user_id = OLD.inviter_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invitations_before
  BEFORE INSERT OR UPDATE OR DELETE ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.invitations_before();

-- Encola la sincronización con Google Sheets en la misma transacción.
CREATE FUNCTION app.invitations_enqueue_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.sheet_sync_jobs (invitation_id, email_normalized, kind)
    VALUES (NEW.id, NEW.guest_email_normalized, 'upsert');
  ELSIF OLD.status = 'active' AND NEW.status = 'cancelled' THEN
    INSERT INTO app.sheet_sync_jobs (invitation_id, email_normalized, kind)
    VALUES (NEW.id, NEW.guest_email_normalized, 'remove');
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER invitations_enqueue_sync
  AFTER INSERT OR UPDATE OF status ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.invitations_enqueue_sync();

-- Al anular: vuelve a marcar la invitación como pendiente de sincronizar.
CREATE FUNCTION app.invitations_mark_pending() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'cancelled' THEN
    NEW.sync_status := 'pending';
    NEW.synced_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER invitations_mark_pending
  BEFORE UPDATE OF status ON app.invitations
  FOR EACH ROW EXECUTE FUNCTION app.invitations_mark_pending();

-- Una invitación de origen "pool" debe estar vinculada a una persona del pool
-- (se verifica al confirmar la transacción).
CREATE FUNCTION app.invitations_pool_link_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'pool' AND NOT EXISTS (
    SELECT 1 FROM app.pool_people p WHERE p.invitation_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'POOL_INVITATION_WITHOUT_POOL_PERSON' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER invitations_pool_link_check
  AFTER INSERT ON app.invitations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.invitations_pool_link_check();

-- Reglas del pool.
CREATE FUNCTION app.pool_people_before() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'available' THEN
      RAISE EXCEPTION 'POOL_DELETE_ONLY_AVAILABLE' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'available' THEN
      RAISE EXCEPTION 'POOL_MUST_START_AVAILABLE' USING ERRCODE = 'P0001';
    END IF;
    PERFORM app.lock_email(NEW.email_normalized);
    IF EXISTS (
      SELECT 1 FROM app.invitations i
       WHERE i.guest_email_normalized = NEW.email_normalized AND i.status = 'active'
    ) THEN
      RAISE EXCEPTION 'POOL_EMAIL_ALREADY_INVITED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.email_normalized <> OLD.email_normalized OR NEW.email <> OLD.email THEN
    RAISE EXCEPTION 'POOL_EMAIL_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'assigned' AND NEW.status = 'available' THEN
    RAISE EXCEPTION 'POOL_ASSIGNED_CANNOT_RETURN' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'assigned' AND NEW.invitation_id IS DISTINCT FROM OLD.invitation_id THEN
    RAISE EXCEPTION 'POOL_INVITATION_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.invitation_id IS NOT NULL AND NEW.status = 'available' THEN
    RAISE EXCEPTION 'POOL_ASSIGNED_CANNOT_RETURN' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'assigned' AND OLD.status <> 'assigned' THEN
    IF OLD.status <> 'available' THEN
      RAISE EXCEPTION 'POOL_NOT_AVAILABLE' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO inv FROM app.invitations WHERE id = NEW.invitation_id;
    IF inv.id IS NULL
       OR inv.source <> 'pool'
       OR inv.status <> 'active'
       OR inv.guest_email_normalized <> NEW.email_normalized
       OR inv.inviter_id <> NEW.assigned_to THEN
      RAISE EXCEPTION 'POOL_INVITATION_MISMATCH' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.status = 'available' AND OLD.status = 'retired' THEN
    PERFORM app.lock_email(NEW.email_normalized);
    IF EXISTS (
      SELECT 1 FROM app.invitations i
       WHERE i.guest_email_normalized = NEW.email_normalized AND i.status = 'active'
    ) THEN
      RAISE EXCEPTION 'POOL_EMAIL_ALREADY_INVITED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pool_people_before
  BEFORE INSERT OR UPDATE OR DELETE ON app.pool_people
  FOR EACH ROW EXECUTE FUNCTION app.pool_people_before();

-- ---------------------------------------------------------------------------
-- En Supabase: impedir cualquier acceso de los roles públicos de la API REST.
-- (En un PostgreSQL local estos roles no existen y el bloque no hace nada.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
