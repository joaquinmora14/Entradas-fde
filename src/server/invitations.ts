import { audit, auditSafe } from "./audit";
import { requireGraduate, type Actor } from "./actor";
import { getDb, pgRaisedCode, type DbClient } from "./db";
import { parseEmail } from "./email";
import { AppError, isAppError } from "./errors";
import { parseIdempotencyKey, withIdempotency } from "./idempotency";
import { runSheetSync } from "./sheets/sync";

export type SyncState = "synced" | "pending";

export type InviteOutcome =
  | { kind: "created"; invitationId: string; email: string; sync: SyncState; remaining: number }
  | { kind: "duplicate"; email: string }
  | { kind: "quota_exhausted" }
  | { kind: "validation"; message: string }
  | { kind: "error"; message: string };

export type PoolOutcome =
  | { kind: "created"; invitationId: string; email: string; sync: SyncState; poolAvailable: number }
  | { kind: "pool_empty" }
  | { kind: "validation"; message: string }
  | { kind: "error"; message: string };

type StoredInvite =
  | { kind: "created"; invitationId: string; email: string }
  | { kind: "duplicate"; email: string }
  | { kind: "quota_exhausted" };

type StoredPool = { kind: "created"; invitationId: string; email: string } | { kind: "pool_empty" };

const TEMPORARY_ERROR = "No pudimos completar la operación por un error temporal. Intentá de nuevo.";

/** Sincroniza en el momento; si Google no responde, la tarea queda en el outbox. */
export async function syncAfterWrite(trigger: string): Promise<void> {
  try {
    await runSheetSync({ trigger, waitForLeaseMs: 4_000, maxBatches: 2 });
  } catch (err) {
    console.error("[sheets] sincronización inmediata falló:", (err as Error).message);
  }
}

async function invitationSyncState(invitationId: string): Promise<SyncState> {
  const { rows } = await getDb().query<{ sync_status: string }>(
    "SELECT sync_status FROM app.invitations WHERE id = $1",
    [invitationId],
  );
  return rows[0]?.sync_status === "synced" ? "synced" : "pending";
}

/** Retira del pool (sin esperar bloqueos) a una persona disponible que acaba de ser invitada por otra vía. */
export async function retireAvailablePoolPerson(c: DbClient, email: string, by: string, reason: string) {
  await c.query(
    `UPDATE app.pool_people
        SET status = 'retired', retired_at = now(), retired_by = $2, retired_reason = $3
      WHERE id IN (
        SELECT id FROM app.pool_people
         WHERE email_normalized = $1 AND status = 'available'
         FOR UPDATE SKIP LOCKED
      )`,
    [email, by, reason],
  );
}

// ---------------------------------------------------------------------------
// Invitación con el cupo individual
// ---------------------------------------------------------------------------
export async function inviteGuest(
  actorIn: Actor | null,
  input: { email: unknown; idempotencyKey: unknown; ip?: string | null },
  opts: { syncNow?: boolean; performedBy?: Actor } = {},
): Promise<InviteOutcome> {
  let actor: Actor;
  try {
    actor = requireGraduate(actorIn);
  } catch (err) {
    return { kind: "validation", message: (err as Error).message };
  }
  const parsed = parseEmail(input.email);
  if (!parsed.ok) {
    await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "invite", result: "rejected", ip: input.ip, details: { reason: "invalid_email" } });
    return { kind: "validation", message: parsed.reason };
  }
  let key: string;
  try {
    key = parseIdempotencyKey(input.idempotencyKey);
  } catch (err) {
    return { kind: "validation", message: (err as Error).message };
  }
  if (parsed.normalized === actor.email) {
    return { kind: "validation", message: "No podés invitarte a vos mismo: ya tenés tu lugar en la fiesta." };
  }
  const isGraduate = await getDb().query(
    "SELECT 1 FROM app.users WHERE email = $1 AND is_graduate AND status <> 'disabled'",
    [parsed.normalized],
  );
  if (isGraduate.rowCount) {
    return { kind: "validation", message: "Esa persona es egresada: ya tiene su lugar y no necesita invitación." };
  }

  let stored: { replayed: boolean; value: StoredInvite };
  try {
    stored = await withIdempotency<StoredInvite>(actor.id, key, "invite", async (c) => {
      const email = parsed.normalized;
      await c.query("SELECT app.lock_email($1)", [email]);
      const dup = await c.query("SELECT 1 FROM app.invitations WHERE guest_email_normalized = $1 AND status = 'active'", [email]);
      if (dup.rowCount) return { kind: "duplicate", email: parsed.original };

      const q = await c.query<{ used: number; initial_quota: number }>(
        "SELECT used, initial_quota FROM app.invitation_quotas WHERE user_id = $1 FOR UPDATE",
        [actor.id],
      );
      if (!q.rows[0] || q.rows[0].used >= q.rows[0].initial_quota) return { kind: "quota_exhausted" };

      await retireAvailablePoolPerson(c, email, actor.id, "invited_directly");
      const ins = await c.query<{ id: string }>(
        `INSERT INTO app.invitations (guest_email, guest_email_normalized, inviter_id, source)
         VALUES ($1, $2, $3, 'direct') RETURNING id`,
        [parsed.original, email, actor.id],
      );
      await audit(
        {
          actorId: opts.performedBy?.id ?? actor.id,
          actorEmail: opts.performedBy?.email ?? actor.email,
          action: "invite",
          result: "success",
          target: ins.rows[0].id,
          ip: input.ip,
          details: {
            guest: email,
            source: "direct",
            ...(opts.performedBy ? { onBehalfOf: actor.email, by: "admin" } : {}),
          },
        },
        c,
      );
      return { kind: "created", invitationId: ins.rows[0].id, email: parsed.original };
    });
  } catch (err) {
    const code = pgRaisedCode(err);
    if (code === "QUOTA_EXCEEDED") return { kind: "quota_exhausted" };
    if (isAppError(err)) return { kind: "validation", message: err.message };
    console.error("[invite] error:", (err as Error).message);
    await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "invite", result: "error", ip: input.ip, details: { guest: parsed.normalized, error: (err as Error).message?.slice(0, 300) } });
    return { kind: "error", message: TEMPORARY_ERROR };
  }

  const v = stored.value;
  if (v.kind !== "created") {
    if (!stored.replayed) {
      await auditSafe({
        actorId: actor.id,
        actorEmail: actor.email,
        action: "invite",
        result: "rejected",
        ip: input.ip,
        details: { guest: parsed.normalized, reason: v.kind },
      });
    }
    return v;
  }
  if (!stored.replayed && opts.syncNow !== false) await syncAfterWrite("invite");
  const [sync, quota] = await Promise.all([invitationSyncState(v.invitationId), getQuota(actor.id)]);
  return { ...v, sync, remaining: quota.remaining };
}

// ---------------------------------------------------------------------------
// Invitación desde el pool común ("Personas fuera de lista")
// Selección FIFO: la persona cargada hace más tiempo sale primero.
// ---------------------------------------------------------------------------
export async function inviteFromPool(
  actorIn: Actor | null,
  input: { idempotencyKey: unknown; ip?: string | null },
  opts: { syncNow?: boolean } = {},
): Promise<PoolOutcome> {
  let actor: Actor;
  let key: string;
  try {
    actor = requireGraduate(actorIn);
    key = parseIdempotencyKey(input.idempotencyKey);
  } catch (err) {
    return { kind: "validation", message: (err as Error).message };
  }

  let stored: { replayed: boolean; value: StoredPool };
  try {
    stored = await withIdempotency<StoredPool>(actor.id, key, "pool_invite", async (c) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const pick = await c.query<{ id: string; email: string; email_normalized: string }>(
          `SELECT id, email, email_normalized FROM app.pool_people
            WHERE status = 'available'
            ORDER BY seq
            LIMIT 1
            FOR UPDATE SKIP LOCKED`,
        );
        const person = pick.rows[0];
        if (!person) return { kind: "pool_empty" };
        await c.query("SELECT app.lock_email($1)", [person.email_normalized]);
        const already = await c.query(
          "SELECT 1 FROM app.invitations WHERE guest_email_normalized = $1 AND status = 'active'",
          [person.email_normalized],
        );
        if (already.rowCount) {
          // Fue invitada por otra vía mientras estaba en el pool: se retira y se prueba con la siguiente.
          await c.query(
            `UPDATE app.pool_people SET status = 'retired', retired_at = now(), retired_reason = 'already_invited'
              WHERE id = $1`,
            [person.id],
          );
          continue;
        }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO app.invitations (guest_email, guest_email_normalized, inviter_id, source)
           VALUES ($1, $2, $3, 'pool') RETURNING id`,
          [person.email, person.email_normalized, actor.id],
        );
        await c.query(
          `UPDATE app.pool_people
              SET status = 'assigned', assigned_to = $2, invitation_id = $3, assigned_at = now()
            WHERE id = $1`,
          [person.id, actor.id, ins.rows[0].id],
        );
        await audit(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            action: "pool_invite",
            result: "success",
            target: ins.rows[0].id,
            ip: input.ip,
            details: { guest: person.email_normalized, poolPersonId: person.id },
          },
          c,
        );
        return { kind: "created", invitationId: ins.rows[0].id, email: person.email };
      }
      throw new Error("Demasiados reintentos al asignar una persona del pool");
    });
  } catch (err) {
    if (isAppError(err)) return { kind: "validation", message: err.message };
    console.error("[pool_invite] error:", (err as Error).message);
    await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "pool_invite", result: "error", ip: input.ip, details: { error: (err as Error).message?.slice(0, 300) } });
    return { kind: "error", message: TEMPORARY_ERROR };
  }

  const v = stored.value;
  if (v.kind !== "created") {
    if (!stored.replayed) {
      await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "pool_invite", result: "rejected", ip: input.ip, details: { reason: "pool_empty" } });
    }
    return v;
  }
  if (!stored.replayed && opts.syncNow !== false) await syncAfterWrite("pool_invite");
  const [sync, poolAvailable] = await Promise.all([invitationSyncState(v.invitationId), countPoolAvailable()]);
  return { ...v, sync, poolAvailable };
}

// ---------------------------------------------------------------------------
// Consultas del panel personal
// ---------------------------------------------------------------------------
export interface Quota {
  initial: number;
  used: number;
  remaining: number;
}

export async function getQuota(userId: string): Promise<Quota> {
  const { rows } = await getDb().query<{ initial_quota: number; used: number }>(
    "SELECT initial_quota, used FROM app.invitation_quotas WHERE user_id = $1",
    [userId],
  );
  const r = rows[0];
  if (!r) return { initial: 0, used: 0, remaining: 0 };
  return { initial: r.initial_quota, used: r.used, remaining: r.initial_quota - r.used };
}

export interface MyInvitation {
  id: string;
  email: string;
  source: "direct" | "pool";
  createdAt: string;
  sync: "synced" | "pending" | "error";
}

export async function listMyInvitations(actor: Actor): Promise<MyInvitation[]> {
  const { rows } = await getDb().query<{
    id: string;
    guest_email: string;
    source: "direct" | "pool";
    created_at: Date;
    sync_status: "synced" | "pending" | "error";
  }>(
    `SELECT id, guest_email, source, created_at, sync_status FROM app.invitations
      WHERE inviter_id = $1 AND status = 'active'
      ORDER BY created_at DESC`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.guest_email,
    source: r.source,
    createdAt: r.created_at.toISOString(),
    sync: r.sync_status,
  }));
}

export async function countPoolAvailable(): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    "SELECT count(*) AS n FROM app.pool_people WHERE status = 'available'",
  );
  return rows[0].n;
}

export async function getDashboard(actor: Actor) {
  const [quota, invitations, poolAvailable] = await Promise.all([
    getQuota(actor.id),
    listMyInvitations(actor),
    countPoolAvailable(),
  ]);
  return {
    quota,
    invitations,
    poolAvailable,
    poolInvitedByMe: invitations.filter((i) => i.source === "pool").length,
  };
}

export function assertNever(x: never): never {
  throw new AppError("VALIDATION", `Valor inesperado: ${String(x)}`);
}

// ---------------------------------------------------------------------------
// Varias entradas a la vez (lista pegada por el egresado)
// ---------------------------------------------------------------------------
export type CheckStatus =
  | "ok" // se puede anotar
  | "invalid" // no es un email válido
  | "repeated" // repetido dentro de la misma lista
  | "mine" // ya lo anotaste vos
  | "taken" // ya lo anotó otro egresado
  | "graduate" // es un egresado
  | "self"; // sos vos

export interface CheckedEmail {
  email: string;
  normalized: string | null;
  status: CheckStatus;
  message?: string;
}

/** Revisa una lista ANTES de anotarla. No modifica nada. */
export async function checkGuestEmails(
  actorIn: Actor | null,
  emails: unknown,
  opts: { revealInviter?: boolean } = {},
): Promise<{ items: CheckedEmail[]; remaining: number }> {
  const actor = requireGraduate(actorIn);
  const list = Array.isArray(emails) ? emails.slice(0, MAX_BATCH).map((e) => String(e ?? "")) : [];
  const items: CheckedEmail[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const p = parseEmail(raw);
    if (!p.ok) {
      items.push({ email: raw, normalized: null, status: "invalid", message: p.reason });
      continue;
    }
    if (seen.has(p.normalized)) {
      items.push({ email: p.original, normalized: p.normalized, status: "repeated" });
      continue;
    }
    seen.add(p.normalized);
    items.push({ email: p.original, normalized: p.normalized, status: p.normalized === actor.email ? "self" : "ok" });
  }
  const norms = items.filter((i) => i.status === "ok").map((i) => i.normalized!);
  if (norms.length) {
    const [inv, grads] = await Promise.all([
      getDb().query<{ email: string; inviter_id: string; label: string }>(
        `SELECT i.guest_email_normalized AS email, i.inviter_id,
                COALESCE(NULLIF(u.display_name, ''), u.email) AS label
           FROM app.invitations i JOIN app.users u ON u.id = i.inviter_id
          WHERE i.status = 'active' AND i.guest_email_normalized = ANY($1::text[])`,
        [norms],
      ),
      getDb().query<{ email: string }>(
        "SELECT email FROM app.users WHERE is_graduate AND status <> 'disabled' AND email = ANY($1::text[])",
        [norms],
      ),
    ]);
    const invBy = new Map(inv.rows.map((r) => [r.email, r]));
    const gradSet = new Set(grads.rows.map((r) => r.email));
    for (const it of items) {
      if (it.status !== "ok") continue;
      const hit = invBy.get(it.normalized!);
      if (hit) {
        it.status = hit.inviter_id === actor.id ? "mine" : "taken";
        if (hit.inviter_id !== actor.id && opts.revealInviter) it.message = `Anotado por ${hit.label}`;
      } else if (gradSet.has(it.normalized!)) {
        it.status = "graduate";
      }
    }
  }
  const quota = await getQuota(actor.id);
  return { items, remaining: quota.remaining };
}

const MAX_BATCH = 50;

export interface BatchItemResult {
  email: string;
  outcome: InviteOutcome;
}

/**
 * Anota varias entradas. Cada email es una operación independiente, atómica e
 * idempotente (cada uno trae su propia clave), así que reintentar el lote
 * completo nunca duplica ni descuenta de más. La planilla se sincroniza una vez al final.
 */
export async function inviteMany(
  actorIn: Actor | null,
  input: { items: unknown; ip?: string | null },
  opts: { syncNow?: boolean; performedBy?: Actor } = {},
): Promise<{ results: BatchItemResult[]; remaining: number }> {
  const actor = requireGraduate(actorIn);
  const raw = Array.isArray(input.items) ? input.items.slice(0, MAX_BATCH) : [];
  const results: BatchItemResult[] = [];
  for (const item of raw) {
    const { email, idempotencyKey } = (item ?? {}) as { email?: unknown; idempotencyKey?: unknown };
    const outcome = await inviteGuest(
      actor,
      { email, idempotencyKey, ip: input.ip },
      { syncNow: false, performedBy: opts.performedBy },
    );
    results.push({ email: String(email ?? ""), outcome });
  }
  if (opts.syncNow !== false && results.some((r) => r.outcome.kind === "created")) {
    await syncAfterWrite("invite_batch");
    // Actualiza el estado de sincronización informado.
    const ids = results.flatMap((r) => (r.outcome.kind === "created" ? [r.outcome.invitationId] : []));
    const { rows } = await getDb().query<{ id: string; sync_status: string }>(
      "SELECT id, sync_status FROM app.invitations WHERE id = ANY($1::uuid[])",
      [ids],
    );
    const synced = new Set(rows.filter((r) => r.sync_status === "synced").map((r) => r.id));
    for (const r of results) {
      if (r.outcome.kind === "created") r.outcome = { ...r.outcome, sync: synced.has(r.outcome.invitationId) ? "synced" : "pending" };
    }
  }
  const quota = await getQuota(actor.id);
  return { results, remaining: quota.remaining };
}
