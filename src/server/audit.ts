import { getDb, type Queryable } from "./db";

export type AuditResult = "success" | "rejected" | "error";

export interface AuditEntry {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  result: AuditResult;
  target?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(entry: AuditEntry, db: Queryable = getDb()): Promise<void> {
  await db.query(
    `INSERT INTO app.audit_logs (actor_id, actor_email, action, result, target, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actorId ?? null,
      entry.actorEmail ?? null,
      entry.action,
      entry.result,
      entry.target ?? null,
      JSON.stringify(entry.details ?? {}),
      entry.ip ?? null,
    ],
  );
}

/** Auditoría "best effort": nunca hace fallar la operación principal. */
export async function auditSafe(entry: AuditEntry): Promise<void> {
  try {
    await audit(entry);
  } catch (err) {
    console.error("[audit] no se pudo registrar", entry.action, (err as Error).message);
  }
}
