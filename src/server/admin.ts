import { audit } from "./audit";
import { requireAdmin, type Actor } from "./actor";
import { createPasswordResetToken, revokeAllSessions, setRegistrationCode, getRegistrationCodeHash, validateDisplayName } from "./auth";
import { parseCsv, MAX_IMPORT_ROWS } from "./csv";
import { getDb, pgRaisedCode, withTransaction } from "./db";
import { parseEmail } from "./email";
import { AppError } from "./errors";
import { alphaCompare } from "./sort";
import { retireAvailablePoolPerson, syncAfterWrite } from "./invitations";
import { poolStats } from "./pool-admin";
import { sheetsConfigured } from "./sheets/sync";
import { emailEnabled } from "./mailer";

export const DEFAULT_QUOTA = 16;

// ---------------------------------------------------------------------------
// Lista autorizada de egresados
// ---------------------------------------------------------------------------
export interface GraduateImportReport {
  added: string[];
  updated: string[];
  unchanged: string[];
  duplicates: string[];
  invalid: Array<{ value: string; reason: string }>;
}

/**
 * Importa la lista autorizada. Formato: una fila por egresado con el email y,
 * opcionalmente, el nombre (en cualquier orden de columnas). Ej.: "email,nombre".
 * No borra a nadie: los egresados que no figuran en el archivo se mantienen.
 */
export async function importGraduates(actorIn: Actor | null, text: string): Promise<GraduateImportReport> {
  const actor = requireAdmin(actorIn);
  const rows = parseCsv(text ?? "");
  if (rows.length > MAX_IMPORT_ROWS) throw new AppError("VALIDATION", `Máximo ${MAX_IMPORT_ROWS} filas por importación.`);
  const report: GraduateImportReport = { added: [], updated: [], unchanged: [], duplicates: [], invalid: [] };
  const seen = new Set<string>();
  const items: Array<{ email: string; name: string | null }> = [];
  rows.forEach((cells, idx) => {
    const emailCell = cells.find((c) => c.includes("@"));
    if (!emailCell) {
      if (idx === 0) return; // encabezado
      report.invalid.push({ value: cells.join(" "), reason: "No se encontró un email" });
      return;
    }
    const p = parseEmail(emailCell);
    if (!p.ok) {
      report.invalid.push({ value: emailCell, reason: p.reason });
      return;
    }
    if (seen.has(p.normalized)) {
      report.duplicates.push(p.normalized);
      return;
    }
    seen.add(p.normalized);
    const nameCell = cells.find((c) => c !== emailCell && c.trim() !== "");
    let name: string | null = null;
    try {
      name = validateDisplayName(nameCell, false);
    } catch (err) {
      report.invalid.push({ value: `${emailCell} ${nameCell}`, reason: (err as Error).message });
      return;
    }
    items.push({ email: p.normalized, name });
  });

  await withTransaction(async (c) => {
    for (const it of items) {
      const ex = await c.query<{ id: string; display_name: string | null; is_graduate: boolean }>(
        "SELECT id, display_name, is_graduate FROM app.users WHERE email = $1 FOR UPDATE",
        [it.email],
      );
      const u = ex.rows[0];
      if (!u) {
        const ins = await c.query<{ id: string }>(
          "INSERT INTO app.users (email, display_name, is_graduate, status) VALUES ($1, $2, true, 'pending') RETURNING id",
          [it.email, it.name],
        );
        await c.query("INSERT INTO app.invitation_quotas (user_id, initial_quota) VALUES ($1, $2)", [
          ins.rows[0].id,
          DEFAULT_QUOTA,
        ]);
        report.added.push(it.email);
        continue;
      }
      const setName = it.name && it.name !== u.display_name;
      if (!u.is_graduate || setName) {
        await c.query(
          `UPDATE app.users SET is_graduate = true, display_name = COALESCE($2, display_name), updated_at = now()
            WHERE id = $1`,
          [u.id, setName ? it.name : null],
        );
        await c.query(
          "INSERT INTO app.invitation_quotas (user_id, initial_quota) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
          [u.id, DEFAULT_QUOTA],
        );
        report.updated.push(it.email);
      } else {
        report.unchanged.push(it.email);
      }
    }
    await audit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "graduates_import",
        result: "success",
        details: {
          added: report.added.length,
          updated: report.updated.length,
          unchanged: report.unchanged.length,
          duplicates: report.duplicates.length,
          invalid: report.invalid.length,
        },
      },
      c,
    );
  });
  return report;
}

export interface GraduateRow {
  id: string;
  email: string;
  displayName: string | null;
  status: "pending" | "active" | "disabled";
  isAdmin: boolean;
  isGraduate: boolean;
  initialQuota: number;
  used: number;
  poolInvited: number;
  registeredAt: string | null;
}

export async function listUsers(actorIn: Actor | null): Promise<GraduateRow[]> {
  requireAdmin(actorIn);
  const { rows } = await getDb().query(
    `SELECT u.id, u.email, u.display_name, u.status, u.is_admin, u.is_graduate, u.registered_at,
            COALESCE(q.initial_quota, 0) AS initial_quota, COALESCE(q.used, 0) AS used,
            (SELECT count(*) FROM app.invitations i
              WHERE i.inviter_id = u.id AND i.source = 'pool' AND i.status = 'active') AS pool_invited
       FROM app.users u
       LEFT JOIN app.invitation_quotas q ON q.user_id = u.id
      ORDER BY lower(COALESCE(u.display_name, u.email))`,
  );
  const sorted = [...rows].sort((a, b) =>
    alphaCompare(a.display_name ?? a.email, b.display_name ?? b.email),
  );
  return sorted.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    isAdmin: r.is_admin,
    isGraduate: r.is_graduate,
    initialQuota: r.initial_quota,
    used: r.used,
    poolInvited: r.pool_invited,
    registeredAt: r.registered_at ? r.registered_at.toISOString() : null,
  }));
}

export async function setUserDisabled(actorIn: Actor | null, userId: string, disabled: boolean): Promise<void> {
  const actor = requireAdmin(actorIn);
  if (userId === actor.id) throw new AppError("VALIDATION", "No podés deshabilitar tu propia cuenta.");
  await withTransaction(async (c) => {
    const { rows } = await c.query<{ email: string; password_hash: string | null }>(
      "SELECT email, password_hash FROM app.users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    if (!rows[0]) throw new AppError("NOT_FOUND", "El usuario no existe.");
    const status = disabled ? "disabled" : rows[0].password_hash ? "active" : "pending";
    await c.query("UPDATE app.users SET status = $2, updated_at = now() WHERE id = $1", [userId, status]);
    if (disabled) await revokeAllSessions(userId, c);
    await audit(
      { actorId: actor.id, actorEmail: actor.email, action: disabled ? "user_disable" : "user_enable", result: "success", target: userId, details: { email: rows[0].email } },
      c,
    );
  });
}

export async function setUserName(actorIn: Actor | null, userId: string, name: unknown): Promise<void> {
  const actor = requireAdmin(actorIn);
  const displayName = validateDisplayName(name, true);
  await withTransaction(async (c) => {
    const r = await c.query<{ email: string }>(
      "UPDATE app.users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING email",
      [userId, displayName],
    );
    if (!r.rows[0]) throw new AppError("NOT_FOUND", "El usuario no existe.");
    await audit(
      { actorId: actor.id, actorEmail: actor.email, action: "user_rename", result: "success", target: userId, details: { email: r.rows[0].email, name: displayName } },
      c,
    );
  });
}

/** Borra un egresado autorizado que todavía no se registró ni invitó a nadie (p. ej. un email mal cargado). */
export async function deletePendingUser(actorIn: Actor | null, userId: string): Promise<void> {
  const actor = requireAdmin(actorIn);
  await withTransaction(async (c) => {
    const { rows } = await c.query<{ email: string; status: string }>(
      "SELECT email, status FROM app.users WHERE id = $1 FOR UPDATE",
      [userId],
    );
    const u = rows[0];
    if (!u) throw new AppError("NOT_FOUND", "El usuario no existe.");
    if (u.status !== "pending") throw new AppError("CONFLICT", "Solo se pueden quitar egresados que todavía no crearon su cuenta.");
    const inv = await c.query("SELECT 1 FROM app.invitations WHERE inviter_id = $1 LIMIT 1", [userId]);
    if (inv.rowCount) throw new AppError("CONFLICT", "Este egresado tiene invitaciones registradas.");
    await c.query("DELETE FROM app.invitation_quotas WHERE user_id = $1", [userId]);
    await c.query("UPDATE app.pool_people SET added_by = NULL WHERE added_by = $1", [userId]);
    await c.query("DELETE FROM app.users WHERE id = $1", [userId]);
    await audit(
      { actorId: actor.id, actorEmail: actor.email, action: "user_delete_pending", result: "success", target: userId, details: { email: u.email } },
      c,
    );
  });
}

export async function generateAccessLink(actorIn: Actor | null, userId: string, baseUrl: string): Promise<string> {
  const actor = requireAdmin(actorIn);
  return withTransaction(async (c) => {
    const { rows } = await c.query<{ email: string; status: string }>(
      "SELECT email, status FROM app.users WHERE id = $1",
      [userId],
    );
    if (!rows[0]) throw new AppError("NOT_FOUND", "El usuario no existe.");
    if (rows[0].status === "disabled") throw new AppError("CONFLICT", "La cuenta está deshabilitada.");
    const token = await createPasswordResetToken(userId, actor.id, c);
    await audit(
      { actorId: actor.id, actorEmail: actor.email, action: "access_link_generated", result: "success", target: userId, details: { email: rows[0].email } },
      c,
    );
    return `${baseUrl}/restablecer?token=${encodeURIComponent(token)}`;
  });
}

// ---------------------------------------------------------------------------
// Invitaciones: consulta y correcciones controladas
// ---------------------------------------------------------------------------
export interface AdminInvitationRow {
  id: string;
  email: string;
  source: "direct" | "pool";
  status: "active" | "cancelled";
  inviter: string;
  inviterEmail: string;
  createdAt: string;
  sync: "pending" | "synced" | "error";
  cancelReason: string | null;
}

export async function listInvitations(
  actorIn: Actor | null,
  opts: { q?: string; status?: string } = {},
): Promise<AdminInvitationRow[]> {
  requireAdmin(actorIn);
  const q = opts.q?.trim().toLowerCase() || null;
  const status = opts.status === "cancelled" ? "cancelled" : opts.status === "all" ? null : "active";
  const { rows } = await getDb().query(
    `SELECT i.id, i.guest_email, i.source, i.status, i.created_at, i.sync_status, i.cancel_reason,
            COALESCE(NULLIF(u.display_name, ''), u.email) AS inviter, u.email AS inviter_email
       FROM app.invitations i JOIN app.users u ON u.id = i.inviter_id
      WHERE ($1::text IS NULL OR i.status = $1)
        AND ($2::text IS NULL OR i.guest_email_normalized LIKE '%' || $2 || '%'
             OR lower(COALESCE(u.display_name, '')) LIKE '%' || $2 || '%' OR u.email LIKE '%' || $2 || '%')
      ORDER BY i.created_at DESC
      LIMIT 3000`,
    [status, q],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.guest_email,
    source: r.source,
    status: r.status,
    inviter: r.inviter,
    inviterEmail: r.inviter_email,
    createdAt: r.created_at.toISOString(),
    sync: r.sync_status,
    cancelReason: r.cancel_reason,
  }));
}

/**
 * Anula una invitación: libera la entrada del egresado (si era del cupo individual),
 * retira a la persona del pool (si venía del pool) y encola su eliminación de la hoja.
 */
export async function cancelInvitation(
  actorIn: Actor | null,
  invitationId: string,
  reason: unknown,
  opts: { syncNow?: boolean } = {},
): Promise<void> {
  const actor = requireAdmin(actorIn);
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : null;
  if (!why) throw new AppError("VALIDATION", "Indicá el motivo de la anulación.");
  await withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string; guest_email_normalized: string; status: string; source: string; inviter_id: string }>(
      "SELECT id, guest_email_normalized, status, source, inviter_id FROM app.invitations WHERE id = $1 FOR UPDATE",
      [invitationId],
    );
    const inv = rows[0];
    if (!inv) throw new AppError("NOT_FOUND", "La invitación no existe.");
    if (inv.status !== "active") throw new AppError("CONFLICT", "La invitación ya estaba anulada.");
    await c.query(
      `UPDATE app.invitations SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
        WHERE id = $1`,
      [invitationId, actor.id, why],
    );
    if (inv.source === "pool") {
      await c.query(
        `UPDATE app.pool_people SET status = 'retired', retired_at = now(), retired_by = $2,
                retired_reason = 'invitation_cancelled'
          WHERE invitation_id = $1`,
        [invitationId, actor.id],
      );
    }
    await audit(
      {
        actorId: actor.id,
        actorEmail: actor.email,
        action: "invitation_cancel",
        result: "success",
        target: invitationId,
        details: { guest: inv.guest_email_normalized, source: inv.source, inviterId: inv.inviter_id, reason: why },
      },
      c,
    );
  });
  if (opts.syncNow !== false) await syncAfterWrite("admin_cancel");
}

/**
 * Corrige el email de una invitación del cupo individual (p. ej. un error de tipeo).
 * En una sola transacción: anula la original y crea la corregida para el mismo
 * egresado, así el cupo queda igual y la hoja se actualiza por el outbox.
 */
export async function correctInvitationEmail(
  actorIn: Actor | null,
  invitationId: string,
  newEmail: unknown,
  opts: { syncNow?: boolean } = {},
): Promise<string> {
  const actor = requireAdmin(actorIn);
  const p = parseEmail(newEmail);
  if (!p.ok) throw new AppError("VALIDATION", p.reason);
  let newId = "";
  try {
    await withTransaction(async (c) => {
      const { rows } = await c.query<{ guest_email_normalized: string; status: string; source: string; inviter_id: string }>(
        "SELECT guest_email_normalized, status, source, inviter_id FROM app.invitations WHERE id = $1 FOR UPDATE",
        [invitationId],
      );
      const inv = rows[0];
      if (!inv) throw new AppError("NOT_FOUND", "La invitación no existe.");
      if (inv.status !== "active") throw new AppError("CONFLICT", "La invitación está anulada.");
      if (inv.source !== "direct") {
        throw new AppError("CONFLICT", "Las invitaciones del pool no se corrigen: anulala si fue un error.");
      }
      if (inv.guest_email_normalized === p.normalized) throw new AppError("VALIDATION", "El email nuevo es igual al actual.");
      for (const e of [inv.guest_email_normalized, p.normalized].sort()) {
        await c.query("SELECT app.lock_email($1)", [e]);
      }
      const dup = await c.query(
        "SELECT 1 FROM app.invitations WHERE guest_email_normalized = $1 AND status = 'active'",
        [p.normalized],
      );
      if (dup.rowCount) throw new AppError("CONFLICT", "El email corregido ya tiene una invitación.");
      await c.query(
        `UPDATE app.invitations SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
                cancel_reason = $3 WHERE id = $1`,
        [invitationId, actor.id, `Corrección de email a ${p.normalized}`],
      );
      await retireAvailablePoolPerson(c, p.normalized, actor.id, "invited_directly");
      const ins = await c.query<{ id: string }>(
        `INSERT INTO app.invitations (guest_email, guest_email_normalized, inviter_id, source)
         VALUES ($1, $2, $3, 'direct') RETURNING id`,
        [p.original, p.normalized, inv.inviter_id],
      );
      newId = ins.rows[0].id;
      await audit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          action: "invitation_correct_email",
          result: "success",
          target: invitationId,
          details: { from: inv.guest_email_normalized, to: p.normalized, newInvitationId: newId, inviterId: inv.inviter_id },
        },
        c,
      );
    });
  } catch (err) {
    if (pgRaisedCode(err) === "QUOTA_EXCEEDED") throw new AppError("CONFLICT", "El egresado no tiene cupo.");
    throw err;
  }
  if (opts.syncNow !== false) await syncAfterWrite("admin_correct");
  return newId;
}

// ---------------------------------------------------------------------------
// Resumen, sincronización y auditoría
// ---------------------------------------------------------------------------
export async function getAdminOverview(actorIn: Actor | null) {
  requireAdmin(actorIn);
  const db = getDb();
  const [quota, users, inv, sync, lastRun, pool] = await Promise.all([
    db.query<{ graduates: number; assigned: number; used: number }>(
      `SELECT count(*) AS graduates, COALESCE(sum(initial_quota), 0)::int AS assigned, COALESCE(sum(used), 0)::int AS used
         FROM app.invitation_quotas q JOIN app.users u ON u.id = q.user_id WHERE u.is_graduate`,
    ),
    db.query<{ status: string; n: number }>(
      "SELECT status, count(*) AS n FROM app.users WHERE is_graduate GROUP BY status",
    ),
    db.query<{ source: string; n: number }>(
      "SELECT source, count(*) AS n FROM app.invitations WHERE status = 'active' GROUP BY source",
    ),
    db.query<{ pending: number; failing: number; oldest: Date | null }>(
      `SELECT count(*) AS pending, count(*) FILTER (WHERE attempts > 0) AS failing, min(created_at) AS oldest
         FROM app.sheet_sync_jobs WHERE status = 'pending'`,
    ),
    db.query<{ started_at: Date; ok: boolean | null; error: string | null }>(
      "SELECT started_at, ok, error FROM app.sync_runs ORDER BY id DESC LIMIT 1",
    ),
    poolStats(),
  ]);
  const usersBy = Object.fromEntries(users.rows.map((r) => [r.status, r.n]));
  const invBy = Object.fromEntries(inv.rows.map((r) => [r.source, r.n]));
  const q = quota.rows[0];
  return {
    graduates: q.graduates,
    registered: usersBy.active ?? 0,
    pendingRegistration: usersBy.pending ?? 0,
    disabled: usersBy.disabled ?? 0,
    ticketsAssigned: q.assigned,
    ticketsUsed: q.used,
    ticketsRemaining: q.assigned - q.used,
    invitationsDirect: invBy.direct ?? 0,
    invitationsPool: invBy.pool ?? 0,
    pool,
    syncPending: sync.rows[0].pending,
    syncFailing: sync.rows[0].failing,
    syncOldestPending: sync.rows[0].oldest ? sync.rows[0].oldest.toISOString() : null,
    lastRun: lastRun.rows[0]
      ? { at: lastRun.rows[0].started_at.toISOString(), ok: lastRun.rows[0].ok, error: lastRun.rows[0].error }
      : null,
    sheetsConfigured: sheetsConfigured(),
    emailEnabled: emailEnabled(),
  };
}

export async function getSyncDetails(actorIn: Actor | null) {
  requireAdmin(actorIn);
  const db = getDb();
  const [jobs, runs] = await Promise.all([
    db.query(
      `SELECT j.id, j.email_normalized, j.kind, j.attempts, j.next_attempt_at, j.last_error, j.created_at
         FROM app.sheet_sync_jobs j WHERE j.status = 'pending' ORDER BY j.id LIMIT 200`,
    ),
    db.query(
      `SELECT id, trigger, started_at, finished_at, ok, jobs, appended, updated, removed, error
         FROM app.sync_runs ORDER BY id DESC LIMIT 30`,
    ),
  ]);
  return {
    pendingJobs: jobs.rows.map((j) => ({
      id: j.id as number,
      email: j.email_normalized as string,
      kind: j.kind as string,
      attempts: j.attempts as number,
      nextAttemptAt: (j.next_attempt_at as Date).toISOString(),
      lastError: j.last_error as string | null,
      createdAt: (j.created_at as Date).toISOString(),
    })),
    runs: runs.rows.map((r) => ({
      id: r.id as number,
      trigger: r.trigger as string,
      startedAt: (r.started_at as Date).toISOString(),
      ok: r.ok as boolean | null,
      jobs: r.jobs as number,
      appended: r.appended as number,
      updated: r.updated as number,
      removed: r.removed as number,
      error: r.error as string | null,
    })),
  };
}

export async function listAuditLogs(actorIn: Actor | null, opts: { action?: string; q?: string; limit?: number } = {}) {
  requireAdmin(actorIn);
  const { rows } = await getDb().query(
    `SELECT id, actor_email, action, result, target, details, ip, created_at
       FROM app.audit_logs
      WHERE ($1::text IS NULL OR action = $1)
        AND ($2::text IS NULL OR actor_email ILIKE '%' || $2 || '%' OR details::text ILIKE '%' || $2 || '%')
      ORDER BY id DESC
      LIMIT $3`,
    [opts.action || null, opts.q?.trim() || null, Math.min(opts.limit ?? 300, 1000)],
  );
  return rows.map((r) => ({
    id: r.id as number,
    actorEmail: r.actor_email as string | null,
    action: r.action as string,
    result: r.result as string,
    target: r.target as string | null,
    details: r.details as Record<string, unknown>,
    ip: r.ip as string | null,
    createdAt: (r.created_at as Date).toISOString(),
  }));
}

export async function getSettings(actorIn: Actor | null) {
  requireAdmin(actorIn);
  return { registrationCodeEnabled: Boolean(await getRegistrationCodeHash()) };
}

export async function updateRegistrationCode(actorIn: Actor | null, code: unknown): Promise<void> {
  const actor = requireAdmin(actorIn);
  const value = typeof code === "string" ? code.trim() : "";
  if (value && value.length < 4) throw new AppError("VALIDATION", "El código debe tener al menos 4 caracteres.");
  await setRegistrationCode(value || null);
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "settings_registration_code",
    result: "success",
    details: { enabled: Boolean(value) },
  });
}

// ---------------------------------------------------------------------------
// Ficha de un egresado (control total desde administración)
// ---------------------------------------------------------------------------
export async function getGraduateActor(adminIn: Actor | null, userId: string): Promise<Actor> {
  requireAdmin(adminIn);
  const { rows } = await getDb().query<{
    id: string;
    email: string;
    display_name: string | null;
    is_admin: boolean;
    is_graduate: boolean;
    status: string;
  }>("SELECT id, email, display_name, is_admin, is_graduate, status FROM app.users WHERE id = $1", [userId]);
  const u = rows[0];
  if (!u || !u.is_graduate) throw new AppError("NOT_FOUND", "El egresado no existe.");
  if (u.status === "disabled") throw new AppError("CONFLICT", "La cuenta del egresado está deshabilitada.");
  return { id: u.id, email: u.email, displayName: u.display_name, isAdmin: u.is_admin, isGraduate: true };
}

export async function getGraduateDetail(adminIn: Actor | null, userId: string) {
  requireAdmin(adminIn);
  const users = await listUsers(adminIn);
  const user = users.find((u) => u.id === userId && u.isGraduate);
  if (!user) throw new AppError("NOT_FOUND", "El egresado no existe.");
  const { rows } = await getDb().query(
    `SELECT id, group_id, guest_email, source, status, created_at, sync_status, cancel_reason
       FROM app.invitations WHERE inviter_id = $1
      ORDER BY status, created_at DESC, id`,
    [userId],
  );
  return {
    user,
    remaining: user.initialQuota - user.used,
    invitations: rows.map((r) => ({
      id: r.id as string,
      groupId: r.group_id as string,
      email: r.guest_email as string,
      source: r.source as "direct" | "pool",
      status: r.status as "active" | "cancelled",
      createdAt: (r.created_at as Date).toISOString(),
      sync: r.sync_status as "pending" | "synced" | "error",
      cancelReason: r.cancel_reason as string | null,
    })),
  };
}
