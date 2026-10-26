import { audit } from "./audit";
import { requireAdmin, type Actor } from "./actor";
import { getDb, pgRaisedCode, withTransaction } from "./db";
import { parseCsv, MAX_IMPORT_ROWS } from "./csv";
import { parseEmail } from "./email";
import { extractEmails } from "@/lib/extract-emails";
import { AppError } from "./errors";

export interface PoolImportReport {
  added: string[];
  duplicates: Array<{ email: string; reason: string }>;
  invalid: Array<{ value: string; reason: string }>;
  conflicts: Array<{ email: string; reason: string }>;
}

const STATUS_LABEL: Record<string, string> = {
  available: "disponible",
  assigned: "ya asignada",
  retired: "retirada",
};

/** Agrega uno o varios emails al pool (texto libre o CSV: se toma la celda que contiene "@"). */
export async function importPool(actorIn: Actor | null, text: string): Promise<PoolImportReport> {
  const actor = requireAdmin(actorIn);
  const rows = parseCsv(text ?? "");
  if (rows.length > MAX_IMPORT_ROWS) throw new AppError("VALIDATION", `Máximo ${MAX_IMPORT_ROWS} filas por importación.`);
  const report: PoolImportReport = { added: [], duplicates: [], invalid: [], conflicts: [] };
  const seen = new Set<string>();
  const candidates: Array<{ original: string; normalized: string }> = [];

  // Cada fila puede traer nombre, mail, DNI, etc.: se toman solo los mails (puede haber varios por fila).
  rows.forEach((cells, idx) => {
    const line = cells.join(" ");
    const found = extractEmails(line);
    if (found.length === 0) {
      if (idx === 0) return; // encabezado
      report.invalid.push({ value: line.slice(0, 120), reason: "No se encontró un mail válido" });
      return;
    }
    for (const { email } of found) {
      const p = parseEmail(email);
      if (!p.ok) {
        report.invalid.push({ value: email, reason: p.reason });
        continue;
      }
      if (seen.has(p.normalized)) {
        report.duplicates.push({ email: p.original, reason: "Repetido dentro de la lista" });
        continue;
      }
      seen.add(p.normalized);
      candidates.push(p);
    }
  });

  if (candidates.length) {
    await withTransaction(async (c) => {
      for (const p of candidates) {
        await c.query("SELECT app.lock_email($1)", [p.normalized]);
        const inPool = await c.query<{ status: string }>(
          "SELECT status FROM app.pool_people WHERE email_normalized = $1",
          [p.normalized],
        );
        if (inPool.rows[0]) {
          report.duplicates.push({
            email: p.original,
            reason: `Ya está en el pool (${STATUS_LABEL[inPool.rows[0].status] ?? inPool.rows[0].status})`,
          });
          continue;
        }
        const invited = await c.query<{ label: string }>(
          `SELECT COALESCE(NULLIF(u.display_name, ''), u.email) AS label
             FROM app.invitations i JOIN app.users u ON u.id = i.inviter_id
            WHERE i.guest_email_normalized = $1 AND i.status = 'active'`,
          [p.normalized],
        );
        if (invited.rows[0]) {
          report.conflicts.push({ email: p.original, reason: `Ya fue invitada por ${invited.rows[0].label}` });
          continue;
        }
        const grad = await c.query("SELECT 1 FROM app.users WHERE email = $1 AND is_graduate", [p.normalized]);
        if (grad.rowCount) {
          report.conflicts.push({ email: p.original, reason: "Es un egresado" });
          continue;
        }
        await c.query(
          "INSERT INTO app.pool_people (email, email_normalized, added_by) VALUES ($1, $2, $3)",
          [p.original, p.normalized, actor.id],
        );
        report.added.push(p.original);
      }
      await audit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          action: "pool_import",
          result: "success",
          details: {
            added: report.added.length,
            duplicates: report.duplicates.length,
            invalid: report.invalid.length,
            conflicts: report.conflicts.length,
            addedEmails: report.added.slice(0, 500),
          },
        },
        c,
      );
    });
  } else {
    await audit({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "pool_import",
      result: "rejected",
      details: { added: 0, duplicates: report.duplicates.length, invalid: report.invalid.length, conflicts: 0 },
    });
  }
  return report;
}

export interface PoolPersonRow {
  id: string;
  email: string;
  status: "available" | "assigned" | "retired";
  addedAt: string;
  assignedTo: string | null;
  assignedAt: string | null;
  retiredReason: string | null;
}

export async function listPool(actorIn: Actor | null, status?: string): Promise<PoolPersonRow[]> {
  requireAdmin(actorIn);
  const { rows } = await getDb().query(
    `SELECT p.id, p.email, p.status, p.added_at, p.assigned_at, p.retired_reason,
            COALESCE(NULLIF(u.display_name, ''), u.email) AS assigned_to
       FROM app.pool_people p
       LEFT JOIN app.users u ON u.id = p.assigned_to
      WHERE ($1::text IS NULL OR p.status = $1)
      ORDER BY CASE p.status WHEN 'available' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
               COALESCE(p.assigned_at, p.added_at) DESC
      LIMIT 3000`,
    [status && ["available", "assigned", "retired"].includes(status) ? status : null],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    status: r.status,
    addedAt: r.added_at.toISOString(),
    assignedTo: r.assigned_to,
    assignedAt: r.assigned_at ? r.assigned_at.toISOString() : null,
    retiredReason: r.retired_reason,
  }));
}

export async function poolStats(): Promise<{ available: number; assigned: number; retired: number }> {
  const { rows } = await getDb().query<{ status: string; n: number }>(
    "SELECT status, count(*) AS n FROM app.pool_people GROUP BY status",
  );
  const out = { available: 0, assigned: 0, retired: 0 };
  for (const r of rows) out[r.status as keyof typeof out] = r.n;
  return out;
}

export async function updatePoolPerson(
  actorIn: Actor | null,
  id: string,
  op: "retire" | "reactivate" | "delete",
): Promise<void> {
  const actor = requireAdmin(actorIn);
  try {
    await withTransaction(async (c) => {
      const { rows } = await c.query<{ id: string; email_normalized: string; status: string; invitation_id: string | null }>(
        "SELECT id, email_normalized, status, invitation_id FROM app.pool_people WHERE id = $1 FOR UPDATE",
        [id],
      );
      const p = rows[0];
      if (!p) throw new AppError("NOT_FOUND", "La persona no existe.");
      if (op === "retire") {
        if (p.status !== "available") throw new AppError("CONFLICT", "Solo se puede desactivar a alguien disponible.");
        await c.query(
          `UPDATE app.pool_people SET status = 'retired', retired_at = now(), retired_by = $2, retired_reason = 'admin'
            WHERE id = $1`,
          [id, actor.id],
        );
      } else if (op === "reactivate") {
        if (p.status !== "retired" || p.invitation_id) {
          throw new AppError("CONFLICT", "Solo se puede reactivar a alguien retirado que nunca fue asignado.");
        }
        await c.query(
          `UPDATE app.pool_people SET status = 'available', retired_at = NULL, retired_by = NULL, retired_reason = NULL
            WHERE id = $1`,
          [id],
        );
      } else {
        if (p.status !== "available") throw new AppError("CONFLICT", "Solo se puede eliminar a alguien disponible.");
        await c.query("DELETE FROM app.pool_people WHERE id = $1", [id]);
      }
      await audit(
        { actorId: actor.id, actorEmail: actor.email, action: `pool_${op}`, result: "success", target: id, details: { email: p.email_normalized } },
        c,
      );
    });
  } catch (err) {
    const code = pgRaisedCode(err);
    if (code === "POOL_EMAIL_ALREADY_INVITED") {
      throw new AppError("CONFLICT", "Esa persona ya tiene una invitación activa; no puede volver al pool.");
    }
    throw err;
  }
}
