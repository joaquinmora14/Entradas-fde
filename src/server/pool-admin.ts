import { audit } from "./audit";
import { requireAdmin, requireGraduateOrAdmin, type Actor } from "./actor";
import { getDb, pgRaisedCode, withTransaction } from "./db";
import { MAX_IMPORT_ROWS } from "./csv";
import { parseEmail } from "./email";
import { analyzeEmailText } from "@/lib/extract-emails";
import { MAX_GROUP_SIZE } from "@/lib/groups";
import { AppError } from "./errors";

export interface PoolImportReport {
  added: string[];
  duplicates: Array<{ email: string; reason: string }>;
  invalid: Array<{ value: string; reason: string }>;
  conflicts: Array<{ email: string; reason: string }>;
  /** Líneas sin mail (nombres, DNI…): se ignoran. */
  ignoredLines?: number;
}

const STATUS_LABEL: Record<string, string> = {
  available: "disponible",
  assigned: "ya asignada",
  retired: "retirada",
};

/**
 * Agrega personas al pool común desde texto libre o CSV (se toman solo los mails).
 * Lo pueden usar el administrador y cualquier egresado.
 * Las personas de una misma carga (un mensaje) forman UN grupo que va junto. Con
 * grouping "each" (archivo CSV del administrador) cada persona queda como su propio grupo.
 */
export async function importPool(
  actorIn: Actor | null,
  text: string,
  opts: { grouping?: "together" | "each" } = {},
): Promise<PoolImportReport> {
  const together = (opts.grouping ?? "together") === "together";
  const actor = requireGraduateOrAdmin(actorIn);
  const limit = actor.isAdmin ? MAX_IMPORT_ROWS : 100;
  const source = text ?? "";
  if (source.split(/\r?\n/).length > limit * 5) throw new AppError("VALIDATION", "La lista es demasiado larga. Cargala en partes.");
  const analysis = analyzeEmailText(source);
  if (analysis.emails.length > limit) throw new AppError("VALIDATION", `Máximo ${limit} mails por vez.`);
  const report: PoolImportReport = { added: [], duplicates: [], invalid: [], conflicts: [], ignoredLines: analysis.ignoredLines };
  const seen = new Set<string>();
  const candidates: Array<{ original: string; normalized: string }> = [];

  // Se toman solo los mails; las líneas sin mail (nombres, DNI…) se ignoran y no son errores.
  for (const u of analysis.unreadable) {
    report.invalid.push({
      value: u.text,
      reason: u.suggestion ? `No es un mail válido. ¿Quisiste decir ${u.suggestion}?` : "No es un mail válido",
    });
  }
  for (const email of analysis.repeated) {
    report.duplicates.push({ email, reason: "Repetido dentro de la lista" });
  }
  for (const { email } of analysis.emails) {
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

  if (candidates.length) {
    await withTransaction(async (c) => {
      // Bloqueos siempre en el mismo orden (alfabético) para no trabarse con otras operaciones.
      for (const email of candidates.map((p) => p.normalized).sort()) await c.query("SELECT app.lock_email($1)", [email]);
      const groupId = (await c.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
      for (const p of candidates) {
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
          report.conflicts.push({
            email: p.original,
            reason: actor.isAdmin ? `Ya fue invitada por ${invited.rows[0].label}` : "Ya tiene entrada",
          });
          continue;
        }
        const grad = await c.query("SELECT 1 FROM app.users WHERE email = $1 AND is_graduate", [p.normalized]);
        if (grad.rowCount) {
          report.conflicts.push({ email: p.original, reason: "Es un egresado" });
          continue;
        }
        await c.query(
          "INSERT INTO app.pool_people (email, email_normalized, added_by, group_id) VALUES ($1, $2, $3, COALESCE($4, gen_random_uuid()))",
          [p.original, p.normalized, actor.id, together ? groupId : null],
        );
        report.added.push(p.original);
      }
      if (together && report.added.length > MAX_GROUP_SIZE) {
        throw new AppError(
          "VALIDATION",
          `Un grupo puede tener hasta ${MAX_GROUP_SIZE} personas (lo máximo que puede dar un egresado). Si son más, cargalos en dos partes.`,
        );
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
            grouping: together ? "together" : "each",
            invalidSamples: report.invalid.slice(0, 30).map((i) => i.value),
            ignoredLines: report.ignoredLines ?? 0,
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
      details: {
        added: 0,
        duplicates: report.duplicates.length,
        invalid: report.invalid.length,
        conflicts: 0,
        invalidSamples: report.invalid.slice(0, 30).map((i) => i.value),
        ignoredLines: report.ignoredLines ?? 0,
      },
    });
  }
  return report;
}

export interface PoolPersonRow {
  id: string;
  groupId: string;
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
    `SELECT p.id, p.group_id, p.email, p.status, p.added_at, p.assigned_at, p.retired_reason,
            COALESCE(NULLIF(u.display_name, ''), u.email) AS assigned_to
       FROM app.pool_people p
       LEFT JOIN app.users u ON u.id = p.assigned_to
      WHERE ($1::text IS NULL OR p.status = $1)
      ORDER BY min(p.seq) OVER (PARTITION BY p.group_id), p.group_id, p.seq
      LIMIT 3000`,
    [status && ["available", "assigned", "retired"].includes(status) ? status : null],
  );
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
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

// ---------------------------------------------------------------------------
// Vista del pool para los egresados (no es pública: requiere sesión)
// ---------------------------------------------------------------------------
export interface PoolGroup {
  /** Id del grupo: se usa para darles entrada a todos juntos. */
  id: string;
  addedBy: string | null;
  mine: boolean;
  addedAt: string;
  people: Array<{ id: string; email: string }>;
}

export interface PoolBoard {
  /** Grupos con gente disponible, los más antiguos primero. */
  available: PoolGroup[];
  /** Grupos que ya recibieron entrada desde la lista (los más recientes primero). */
  assigned: Array<{ id: string; emails: string[]; invitedBy: string; assignedAt: string }>;
}

export async function getPoolBoard(actorIn: Actor | null): Promise<PoolBoard> {
  const actor = requireGraduateOrAdmin(actorIn);
  const db = getDb();
  const [avail, assigned] = await Promise.all([
    db.query(
      `SELECT p.id, p.group_id, p.email, p.added_at, p.added_by,
              COALESCE(NULLIF(u.display_name, ''), CASE WHEN u.is_admin AND NOT u.is_graduate THEN 'Organización' END) AS added_by_name
         FROM app.pool_people p LEFT JOIN app.users u ON u.id = p.added_by
        WHERE p.status = 'available'
        ORDER BY min(p.seq) OVER (PARTITION BY p.group_id), p.group_id, p.seq`,
    ),
    db.query(
      `SELECT p.group_id, p.assigned_to, p.email, p.assigned_at, COALESCE(NULLIF(u.display_name, ''), 'Egresado') AS invited_by
         FROM app.pool_people p JOIN app.users u ON u.id = p.assigned_to
        WHERE p.status = 'assigned'
        ORDER BY max(p.assigned_at) OVER (PARTITION BY p.group_id, p.assigned_to) DESC, p.group_id, p.assigned_to, p.seq
        LIMIT 1000`,
    ),
  ]);
  const groups = new Map<string, PoolGroup>();
  for (const r of avail.rows) {
    let g = groups.get(r.group_id);
    if (!g) {
      g = { id: r.group_id, addedBy: r.added_by_name, mine: r.added_by === actor.id, addedAt: r.added_at.toISOString(), people: [] };
      groups.set(r.group_id, g);
    }
    g.people.push({ id: r.id, email: r.email });
  }
  const given = new Map<string, PoolBoard["assigned"][number]>();
  for (const r of assigned.rows) {
    const k = `${r.group_id}:${r.assigned_to}`;
    let g = given.get(k);
    if (!g) {
      g = { id: k, emails: [], invitedBy: r.invited_by, assignedAt: r.assigned_at.toISOString() };
      given.set(k, g);
    }
    g.emails.push(r.email);
  }
  return { available: [...groups.values()], assigned: [...given.values()] };
}

// ---------------------------------------------------------------------------
// Revisión previa de una lista antes de sumarla al pool (no modifica nada)
// ---------------------------------------------------------------------------
export type PoolCheckStatus = "ok" | "invalid" | "repeated" | "in_pool" | "has_entry" | "graduate";

export interface PoolCheckItem {
  email: string;
  status: PoolCheckStatus;
  message?: string;
}

export async function checkPoolEmails(actorIn: Actor | null, emails: unknown): Promise<{ items: PoolCheckItem[] }> {
  const actor = requireGraduateOrAdmin(actorIn);
  const list = Array.isArray(emails) ? emails.slice(0, 200).map((e) => String(e ?? "")) : [];
  const items: Array<PoolCheckItem & { normalized?: string }> = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = parseEmail(raw);
    if (!p.ok) {
      items.push({ email: raw, status: "invalid", message: p.reason });
    } else if (seen.has(p.normalized)) {
      items.push({ email: p.original, status: "repeated" });
    } else {
      seen.add(p.normalized);
      items.push({ email: p.original, normalized: p.normalized, status: "ok" });
    }
  }
  const norms = items.filter((i) => i.status === "ok").map((i) => i.normalized!);
  if (norms.length) {
    const db = getDb();
    const [pool, inv, grads] = await Promise.all([
      db.query<{ email: string; status: string }>(
        "SELECT email_normalized AS email, status FROM app.pool_people WHERE email_normalized = ANY($1::text[])",
        [norms],
      ),
      db.query<{ email: string; label: string }>(
        `SELECT i.guest_email_normalized AS email, COALESCE(NULLIF(u.display_name, ''), u.email) AS label
           FROM app.invitations i JOIN app.users u ON u.id = i.inviter_id
          WHERE i.status = 'active' AND i.guest_email_normalized = ANY($1::text[])`,
        [norms],
      ),
      db.query<{ email: string }>("SELECT email FROM app.users WHERE is_graduate AND email = ANY($1::text[])", [norms]),
    ]);
    const poolBy = new Map(pool.rows.map((r) => [r.email, r.status]));
    const invBy = new Map(inv.rows.map((r) => [r.email, r.label]));
    const gradSet = new Set(grads.rows.map((r) => r.email));
    for (const it of items) {
      if (it.status !== "ok") continue;
      const n = it.normalized!;
      if (invBy.has(n)) {
        it.status = "has_entry";
        if (actor.isAdmin) it.message = `Anotado por ${invBy.get(n)}`;
      } else if (gradSet.has(n)) {
        it.status = "graduate";
      } else if (poolBy.has(n)) {
        it.status = "in_pool";
        it.message = `Ya está en la lista (${STATUS_LABEL[poolBy.get(n)!] ?? poolBy.get(n)})`;
      }
    }
  }
  return { items: items.map(({ email, status, message }) => (message ? { email, status, message } : { email, status })) };
}
