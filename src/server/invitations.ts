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
  | { kind: "created"; groupId: string; emails: string[]; sync: SyncState; remaining: number }
  | { kind: "unavailable" }
  | { kind: "quota_exhausted"; needed: number; remaining: number }
  | { kind: "validation"; message: string }
  | { kind: "error"; message: string };

/** Resultado de anotar un grupo (una lista pegada): se anotan todos juntos o ninguno. */
export type GroupOutcome =
  | { kind: "created"; groupId: string; emails: string[]; sync: SyncState; remaining: number }
  | { kind: "conflict"; blocked: Array<{ email: string; reason: "taken" | "mine" }> }
  | { kind: "quota_exhausted"; needed: number; remaining: number }
  | { kind: "validation"; message: string }
  | { kind: "error"; message: string };

type StoredInvite =
  | { kind: "created"; invitationId: string; email: string }
  | { kind: "duplicate"; email: string }
  | { kind: "quota_exhausted" };

type StoredPool =
  | { kind: "created"; groupId: string; invitationIds: string[]; emails: string[] }
  | { kind: "unavailable" }
  | { kind: "quota_exhausted"; needed: number; remaining: number };

type StoredGroup =
  | { kind: "created"; groupId: string; invitationIds: string[]; emails: string[] }
  | { kind: "conflict"; blocked: Array<{ email: string; reason: "taken" | "mine" }> }
  | { kind: "quota_exhausted"; needed: number; remaining: number };

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
// La gente pide entradas en grupo (van juntos): el egresado elige un grupo de la
// lista y les da una entrada a TODOS, o a ninguno.
// ---------------------------------------------------------------------------
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function inviteFromPool(
  actorIn: Actor | null,
  input: { poolGroupId: unknown; idempotencyKey: unknown; ip?: string | null },
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
  const groupId = typeof input.poolGroupId === "string" && UUID_ANY.test(input.poolGroupId) ? input.poolGroupId : null;
  if (!groupId) return { kind: "validation", message: "Elegí un grupo de la lista." };

  let stored: { replayed: boolean; value: StoredPool };
  try {
    stored = await withIdempotency<StoredPool>(actor.id, key, "pool_invite", async (c) => {
      // Se bloquean todas las filas del grupo (siempre en el mismo orden): si dos egresados
      // eligen el mismo grupo, uno espera y después ve que ya no está disponible.
      const pick = await c.query<{ id: string; email: string; email_normalized: string; status: string }>(
        "SELECT id, email, email_normalized, status FROM app.pool_people WHERE group_id = $1 ORDER BY id FOR UPDATE",
        [groupId],
      );
      const candidates = pick.rows.filter((p) => p.status === "available");
      if (!candidates.length) return { kind: "unavailable" };
      for (const email of [...new Set(candidates.map((p) => p.email_normalized))].sort()) {
        await c.query("SELECT app.lock_email($1)", [email]);
      }
      const already = await c.query<{ email: string }>(
        "SELECT guest_email_normalized AS email FROM app.invitations WHERE status = 'active' AND guest_email_normalized = ANY($1::text[])",
        [candidates.map((p) => p.email_normalized)],
      );
      const taken = new Set(already.rows.map((r) => r.email));
      if (taken.size) {
        // Alguno fue invitado por otra vía mientras estaba en la lista: ya tiene entrada, se retira.
        await c.query(
          `UPDATE app.pool_people SET status = 'retired', retired_at = now(), retired_reason = 'already_invited'
            WHERE id = ANY($1::uuid[])`,
          [candidates.filter((p) => taken.has(p.email_normalized)).map((p) => p.id)],
        );
      }
      const people = (
        await c.query<{ id: string; email: string; email_normalized: string }>(
          "SELECT id, email, email_normalized FROM app.pool_people WHERE id = ANY($1::uuid[]) ORDER BY seq",
          [candidates.filter((p) => !taken.has(p.email_normalized)).map((p) => p.id)],
        )
      ).rows;
      if (!people.length) return { kind: "unavailable" };
      const q = await c.query<{ used: number; initial_quota: number }>(
        "SELECT used, initial_quota FROM app.invitation_quotas WHERE user_id = $1 FOR UPDATE",
        [actor.id],
      );
      const left = q.rows[0] ? q.rows[0].initial_quota - q.rows[0].used : 0;
      if (people.length > left) return { kind: "quota_exhausted", needed: people.length, remaining: left };
      const ids: string[] = [];
      for (const person of people) {
        // clock_timestamp(): cada fila con su hora exacta, así la planilla respeta el orden del grupo.
        const ins = await c.query<{ id: string }>(
          `INSERT INTO app.invitations (guest_email, guest_email_normalized, inviter_id, source, group_id, created_at)
           VALUES ($1, $2, $3, 'pool', $4, clock_timestamp()) RETURNING id`,
          [person.email, person.email_normalized, actor.id, groupId],
        );
        await c.query(
          `UPDATE app.pool_people
              SET status = 'assigned', assigned_to = $2, invitation_id = $3, assigned_at = now()
            WHERE id = $1`,
          [person.id, actor.id, ins.rows[0].id],
        );
        ids.push(ins.rows[0].id);
      }
      await audit(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          action: "pool_invite",
          result: "success",
          target: groupId,
          ip: input.ip,
          details: { guests: people.map((p) => p.email_normalized), poolGroupId: groupId, size: people.length },
        },
        c,
      );
      return { kind: "created", groupId, invitationIds: ids, emails: people.map((p) => p.email) };
    });
  } catch (err) {
    if (pgRaisedCode(err) === "QUOTA_EXCEEDED") return { kind: "quota_exhausted", needed: 0, remaining: (await getQuota(actor.id)).remaining };
    if (isAppError(err)) return { kind: "validation", message: err.message };
    console.error("[pool_invite] error:", (err as Error).message);
    await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "pool_invite", result: "error", ip: input.ip, details: { error: (err as Error).message?.slice(0, 300) } });
    return { kind: "error", message: TEMPORARY_ERROR };
  }

  const v = stored.value;
  if (v.kind !== "created") {
    if (!stored.replayed) {
      await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "pool_invite", result: "rejected", ip: input.ip, details: { reason: v.kind, poolGroupId: groupId } });
    }
    return v;
  }
  if (!stored.replayed && opts.syncNow !== false) await syncAfterWrite("pool_invite");
  const [sync, quota] = await Promise.all([groupSyncState(v.invitationIds), getQuota(actor.id)]);
  return { kind: "created", groupId: v.groupId, emails: v.emails, sync, remaining: quota.remaining };
}

async function groupSyncState(ids: string[]): Promise<SyncState> {
  const { rows } = await getDb().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM app.invitations WHERE id = ANY($1::uuid[]) AND sync_status <> 'synced'",
    [ids],
  );
  return rows[0].n === 0 ? "synced" : "pending";
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
  groupId: string;
  email: string;
  source: "direct" | "pool";
  createdAt: string;
  sync: "synced" | "pending" | "error";
}

export async function listMyInvitations(actor: Actor): Promise<MyInvitation[]> {
  const { rows } = await getDb().query<{
    id: string;
    group_id: string;
    guest_email: string;
    source: "direct" | "pool";
    created_at: Date;
    sync_status: "synced" | "pending" | "error";
  }>(
    `SELECT id, group_id, guest_email, source, created_at, sync_status FROM app.invitations
      WHERE inviter_id = $1 AND status = 'active'
      ORDER BY created_at, id`,
    [actor.id],
  );
  return rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    email: r.guest_email,
    source: r.source,
    createdAt: r.created_at.toISOString(),
    sync: r.sync_status,
  }));
}

export interface InvitationGroup<T extends { groupId: string; createdAt: string } = MyInvitation> {
  id: string;
  createdAt: string;
  items: T[];
}

/**
 * Agrupa invitaciones por grupo: los grupos más recientes primero y, dentro de cada grupo,
 * los mails en el orden en que se anotaron. La lista tiene que venir en orden de anotación
 * (ORDER BY created_at, id en la base, con precisión de microsegundos): ese orden se respeta
 * tal cual dentro de cada grupo, porque en JavaScript la hora se redondea a milisegundos y
 * dos mails del mismo grupo pueden empatar.
 */
export function groupInvitations<T extends { groupId: string; createdAt: string }>(list: T[]): InvitationGroup<T>[] {
  const map = new Map<string, InvitationGroup<T>>();
  for (const it of list) {
    const g = map.get(it.groupId);
    if (g) {
      g.items.push(it);
      if (it.createdAt > g.createdAt) g.createdAt = it.createdAt;
    } else {
      map.set(it.groupId, { id: it.groupId, createdAt: it.createdAt, items: [it] });
    }
  }
  const groups = [...map.values()];
  return groups.reverse().sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
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
    groups: groupInvitations(invitations),
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

/**
 * Anota un grupo: todos los mails de una lista pegada van juntos, así que se anotan
 * TODOS en una sola transacción o NINGUNO (si a alguno lo anotó otro egresado mientras
 * se revisaba, o si no alcanzan las entradas). Reintentar con la misma clave devuelve el
 * mismo resultado sin duplicar ni descontar de más.
 */
export async function inviteGroup(
  actorIn: Actor | null,
  input: { emails: unknown; idempotencyKey: unknown; ip?: string | null },
  opts: { syncNow?: boolean; performedBy?: Actor } = {},
): Promise<GroupOutcome> {
  let actor: Actor;
  let key: string;
  try {
    actor = requireGraduate(actorIn);
    key = parseIdempotencyKey(input.idempotencyKey);
  } catch (err) {
    return { kind: "validation", message: (err as Error).message };
  }
  const raw = Array.isArray(input.emails) ? input.emails.map((e) => String(e ?? "")) : [];
  if (raw.length === 0) return { kind: "validation", message: "No hay mails para anotar." };
  if (raw.length > MAX_BATCH) return { kind: "validation", message: `Anotá como máximo ${MAX_BATCH} por vez.` };
  const people: Array<{ original: string; normalized: string }> = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const p = parseEmail(r);
    if (!p.ok) return { kind: "validation", message: `${r.trim() || "Un mail"}: ${p.reason}` };
    if (seen.has(p.normalized)) continue; // el mismo mail dos veces es la misma persona
    seen.add(p.normalized);
    if (p.normalized === actor.email) return { kind: "validation", message: "No podés invitarte a vos mismo: ya tenés tu lugar en la fiesta." };
    people.push(p);
  }
  const grads = await getDb().query<{ email: string }>(
    "SELECT email FROM app.users WHERE is_graduate AND status <> 'disabled' AND email = ANY($1::text[])",
    [people.map((p) => p.normalized)],
  );
  if (grads.rowCount) {
    return { kind: "validation", message: `${grads.rows[0].email} es egresado: ya tiene su lugar y no necesita invitación.` };
  }

  let stored: { replayed: boolean; value: StoredGroup };
  try {
    stored = await withIdempotency<StoredGroup>(actor.id, key, "invite_group", async (c) => {
      // Bloqueos siempre en el mismo orden (alfabético) para que dos grupos no se traben entre sí.
      for (const email of people.map((p) => p.normalized).sort()) await c.query("SELECT app.lock_email($1)", [email]);
      const dup = await c.query<{ email: string; inviter_id: string }>(
        "SELECT guest_email_normalized AS email, inviter_id FROM app.invitations WHERE status = 'active' AND guest_email_normalized = ANY($1::text[])",
        [people.map((p) => p.normalized)],
      );
      if (dup.rowCount) {
        const by = new Map(dup.rows.map((r) => [r.email, r.inviter_id]));
        return {
          kind: "conflict",
          blocked: people
            .filter((p) => by.has(p.normalized))
            .map((p) => ({ email: p.original, reason: by.get(p.normalized) === actor.id ? ("mine" as const) : ("taken" as const) })),
        };
      }
      const q = await c.query<{ used: number; initial_quota: number }>(
        "SELECT used, initial_quota FROM app.invitation_quotas WHERE user_id = $1 FOR UPDATE",
        [actor.id],
      );
      const left = q.rows[0] ? q.rows[0].initial_quota - q.rows[0].used : 0;
      if (people.length > left) return { kind: "quota_exhausted", needed: people.length, remaining: left };

      const groupId = (await c.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0].id;
      const ids: string[] = [];
      for (const p of people) {
        // Si estaba en "fuera de lista", sale de ahí: ya tiene entrada.
        await retireAvailablePoolPerson(c, p.normalized, actor.id, "invited_directly");
        const ins = await c.query<{ id: string }>(
          `INSERT INTO app.invitations (guest_email, guest_email_normalized, inviter_id, source, group_id, created_at)
           VALUES ($1, $2, $3, 'direct', $4, clock_timestamp()) RETURNING id`,
          [p.original, p.normalized, actor.id, groupId],
        );
        ids.push(ins.rows[0].id);
      }
      await audit(
        {
          actorId: opts.performedBy?.id ?? actor.id,
          actorEmail: opts.performedBy?.email ?? actor.email,
          action: "invite",
          result: "success",
          target: groupId,
          ip: input.ip,
          details: {
            guests: people.map((p) => p.normalized),
            size: people.length,
            source: "direct",
            ...(opts.performedBy ? { onBehalfOf: actor.email, by: "admin" } : {}),
          },
        },
        c,
      );
      return { kind: "created", groupId, invitationIds: ids, emails: people.map((p) => p.original) };
    });
  } catch (err) {
    if (pgRaisedCode(err) === "QUOTA_EXCEEDED") {
      return { kind: "quota_exhausted", needed: people.length, remaining: (await getQuota(actor.id)).remaining };
    }
    if (isAppError(err)) return { kind: "validation", message: err.message };
    console.error("[invite_group] error:", (err as Error).message);
    await auditSafe({ actorId: actor.id, actorEmail: actor.email, action: "invite", result: "error", ip: input.ip, details: { guests: people.map((p) => p.normalized), error: (err as Error).message?.slice(0, 300) } });
    return { kind: "error", message: TEMPORARY_ERROR };
  }

  const v = stored.value;
  if (v.kind !== "created") {
    if (!stored.replayed) {
      await auditSafe({
        actorId: opts.performedBy?.id ?? actor.id,
        actorEmail: opts.performedBy?.email ?? actor.email,
        action: "invite",
        result: "rejected",
        ip: input.ip,
        details: { guests: people.map((p) => p.normalized), reason: v.kind },
      });
    }
    return v;
  }
  if (!stored.replayed && opts.syncNow !== false) await syncAfterWrite("invite_group");
  const [sync, quota] = await Promise.all([groupSyncState(v.invitationIds), getQuota(actor.id)]);
  return { kind: "created", groupId: v.groupId, emails: v.emails, sync, remaining: quota.remaining };
}
