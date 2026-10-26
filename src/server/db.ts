import pg from "pg";

// int8 (count, bigserial) como number: los volúmenes de esta app son pequeños.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

const globalForDb = globalThis as unknown as { __fdePool?: pg.Pool };

function sslFor(connectionString: string): pg.PoolConfig["ssl"] {
  const url = new URL(connectionString);
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.searchParams.get("sslmode") === "disable"
  ) {
    return false;
  }
  // El pooler de Supabase usa TLS con un certificado de su propia CA.
  return { rejectUnauthorized: false };
}

export function getDb(): pg.Pool {
  if (!globalForDb.__fdePool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL no está configurada");
    }
    const url = new URL(connectionString);
    url.searchParams.delete("sslmode");
    globalForDb.__fdePool = new pg.Pool({
      connectionString: url.toString(),
      ssl: sslFor(connectionString),
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    globalForDb.__fdePool.on("error", (err) => {
      console.error("[db] error en conexión inactiva:", err.message);
    });
  }
  return globalForDb.__fdePool;
}

export async function closeDb(): Promise<void> {
  if (globalForDb.__fdePool) {
    const p = globalForDb.__fdePool;
    globalForDb.__fdePool = undefined;
    await p.end();
  }
}

/** Ejecuta fn dentro de una transacción. Hace ROLLBACK si fn lanza. */
export async function withTransaction<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Error de PostgreSQL lanzado con RAISE EXCEPTION '<CODE>' desde los triggers. */
export function pgRaisedCode(err: unknown): string | null {
  if (err && typeof err === "object" && (err as { code?: string }).code === "P0001") {
    return (err as { message?: string }).message ?? null;
  }
  return null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === "23505" && (!constraint || e.constraint === constraint);
}
