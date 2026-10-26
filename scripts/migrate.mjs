// Aplica las migraciones SQL de /migrations en orden, una sola vez cada una.
// Uso: DATABASE_URL=... node scripts/migrate.mjs
// Se ejecuta automáticamente en cada build de producción (ver package.json).
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "..", "migrations");

export async function migrate(connectionString, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('fde-migrations', 0))");
    await client.query("CREATE SCHEMA IF NOT EXISTS app");
    await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query("SELECT name FROM app.schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      log(`Aplicando migración ${file}…`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO app.schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Falló la migración ${file}: ${err.message}`);
      }
    }
    log("Migraciones al día.");
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('fde-migrations', 0))").catch(() => {});
    await client.end();
  }
}

export function sslFor(connectionString) {
  const url = new URL(connectionString);
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || url.searchParams.get("sslmode") === "disable") {
    return false;
  }
  // Supabase/Neon exigen TLS. El certificado del pooler de Supabase lo emite su propia CA.
  return { rejectUnauthorized: false };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const url = process.env.DATABASE_URL_MIGRATIONS || process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL_ENV === "production") {
      console.error("DATABASE_URL no está configurada: no se pueden aplicar las migraciones.");
      process.exit(1);
    }
    console.log("DATABASE_URL no configurada; se omiten las migraciones.");
    process.exit(0);
  }
  migrate(url).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
