-- Orden exacto de carga del pool (FIFO). Varias personas cargadas en la misma
-- transacción comparten added_at, así que se agrega un número secuencial.
ALTER TABLE app.pool_people ADD COLUMN seq bigserial;
DROP INDEX IF EXISTS app.pool_available_fifo_idx;
CREATE INDEX pool_available_fifo_idx ON app.pool_people (seq) WHERE status = 'available';
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM %I', r);
    END IF;
  END LOOP;
END $$;
