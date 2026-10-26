import { getDb, type DbClient } from "./db";
import { AppError } from "./errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseIdempotencyKey(key: unknown): string {
  if (typeof key !== "string" || !UUID_RE.test(key)) {
    throw new AppError("VALIDATION", "Solicitud inválida. Recargá la página e intentá de nuevo.");
  }
  return key.toLowerCase();
}

/**
 * Ejecuta fn en una transacción protegida por una clave de idempotencia.
 * - Si la clave ya se usó, devuelve el resultado guardado sin repetir la operación.
 * - Si otra solicitud con la misma clave está en curso, espera a que termine
 *   (el índice único bloquea) y devuelve su resultado.
 * - Si fn lanza, se revierte todo y la clave queda libre para reintentar.
 */
export async function withIdempotency<T extends object>(
  userId: string,
  key: string,
  action: string,
  fn: (c: DbClient) => Promise<T>,
): Promise<{ replayed: boolean; value: T }> {
  const client = await getDb().connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO app.idempotency_keys (user_id, key, action, response)
       VALUES ($1, $2, $3, '{}'::jsonb)
       ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, key, action],
    );
    if (ins.rowCount === 0) {
      const { rows } = await client.query<{ action: string; response: T }>(
        "SELECT action, response FROM app.idempotency_keys WHERE user_id = $1 AND key = $2",
        [userId, key],
      );
      await client.query("ROLLBACK");
      if (!rows[0] || rows[0].action !== action) {
        throw new AppError("VALIDATION", "Solicitud inválida. Recargá la página e intentá de nuevo.");
      }
      return { replayed: true, value: rows[0].response };
    }
    const value = await fn(client);
    await client.query("UPDATE app.idempotency_keys SET response = $3 WHERE user_id = $1 AND key = $2", [
      userId,
      key,
      JSON.stringify(value),
    ]);
    await client.query("COMMIT");
    return { replayed: false, value };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
