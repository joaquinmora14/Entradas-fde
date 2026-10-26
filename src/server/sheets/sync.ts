import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { normalizeEmail } from "../email";
import { GoogleSheetsClient, googleSheetsConfigFromEnv } from "./google";
import type { SheetRow, SheetsClient } from "./types";

// ---------------------------------------------------------------------------
// Cliente de Google Sheets (se puede reemplazar en las pruebas)
// ---------------------------------------------------------------------------
let override: SheetsClient | null | undefined;
let cached: { key: string; client: SheetsClient } | null = null;

export function setSheetsClientForTests(client: SheetsClient | null | undefined): void {
  override = client;
}

export function getSheetsClient(): SheetsClient | null {
  if (override !== undefined) return override;
  const cfg = googleSheetsConfigFromEnv();
  if (!cfg) return null;
  const key = `${cfg.spreadsheetId}|${cfg.tab}|${cfg.clientEmail}`;
  if (!cached || cached.key !== key) cached = { key, client: new GoogleSheetsClient(cfg) };
  return cached.client;
}

export function sheetsConfigured(): boolean {
  try {
    return getSheetsClient() !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Estado deseado (PostgreSQL es la fuente de verdad)
// ---------------------------------------------------------------------------
interface Desired {
  guest: string;
  invitedBy: string;
}

async function loadDesired(emails: string[] | null): Promise<Map<string, Desired>> {
  const { rows } = await getDb().query<{ guest_email: string; email: string; label: string }>(
    `SELECT i.guest_email, i.guest_email_normalized AS email,
            COALESCE(NULLIF(btrim(u.display_name), ''), u.email) AS label
       FROM app.invitations i
       JOIN app.users u ON u.id = i.inviter_id
      WHERE i.status = 'active'
        AND ($1::text[] IS NULL OR i.guest_email_normalized = ANY($1::text[]))`,
    [emails],
  );
  return new Map(rows.map((r) => [r.email, { guest: r.guest_email, invitedBy: r.label }]));
}

export interface SheetPlan {
  appends: Array<[string, string]>;
  updates: Array<{ rowNumber: number; invitedBy: string }>;
  deletes: number[];
}

/**
 * Calcula los cambios mínimos para que la hoja refleje la base de datos.
 * scope = emails a revisar (sincronización incremental) o null (reconciliación completa).
 * Nunca agrega una fila para un email que ya figura en la hoja: por eso los
 * reintentos son seguros aunque una escritura anterior haya llegado a aplicarse.
 */
export function planSheetChanges(
  rows: SheetRow[],
  desired: Map<string, Desired>,
  scope: Set<string> | null,
): SheetPlan {
  const byEmail = new Map<string, SheetRow[]>();
  for (const row of rows) {
    const key = normalizeEmail(row.guest);
    if (!key) continue; // filas vacías o sin email: no las tocamos
    const list = byEmail.get(key) ?? [];
    list.push(row);
    byEmail.set(key, list);
  }
  const emails = scope ?? new Set<string>([...byEmail.keys(), ...desired.keys()]);
  const plan: SheetPlan = { appends: [], updates: [], deletes: [] };
  for (const email of [...emails].sort()) {
    const existing = byEmail.get(email) ?? [];
    const want = desired.get(email);
    if (want) {
      if (existing.length === 0) {
        plan.appends.push([want.guest, want.invitedBy]);
      } else {
        if (existing[0].invitedBy !== want.invitedBy) {
          plan.updates.push({ rowNumber: existing[0].rowNumber, invitedBy: want.invitedBy });
        }
        plan.deletes.push(...existing.slice(1).map((r) => r.rowNumber));
      }
    } else {
      plan.deletes.push(...existing.map((r) => r.rowNumber));
    }
  }
  return plan;
}

async function applyPlan(client: SheetsClient, plan: SheetPlan): Promise<void> {
  // Orden: actualizaciones (números de fila originales), borrados (de abajo hacia arriba), altas al final.
  for (const u of plan.updates) await client.updateInvitedBy(u.rowNumber, u.invitedBy);
  if (plan.deletes.length) await client.deleteRows(plan.deletes);
  if (plan.appends.length) await client.appendRows(plan.appends);
}

// ---------------------------------------------------------------------------
// Lease: un solo proceso escribe en la hoja a la vez
// ---------------------------------------------------------------------------
async function acquireLease(holder: string, seconds: number): Promise<boolean> {
  const { rowCount } = await getDb().query(
    `UPDATE app.sync_lease SET holder = $1, expires_at = now() + make_interval(secs => $2)
      WHERE id = 1 AND (expires_at < now() OR holder = $1)`,
    [holder, seconds],
  );
  return rowCount === 1;
}

async function releaseLease(holder: string): Promise<void> {
  await getDb().query(
    "UPDATE app.sync_lease SET holder = NULL, expires_at = '-infinity' WHERE id = 1 AND holder = $1",
    [holder],
  );
}

async function withLease<T>(
  seconds: number,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const holder = randomUUID();
  const deadline = Date.now() + waitMs;
  while (!(await acquireLease(holder, seconds))) {
    if (Date.now() >= deadline) return { acquired: false };
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await releaseLease(holder).catch(() => {});
  }
}

function safeError(err: unknown): string {
  const e = err as { message?: string; response?: { status?: number } };
  const status = e?.response?.status ? `HTTP ${e.response.status}: ` : "";
  return `${status}${e?.message ?? String(err)}`.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[clave]").slice(0, 500);
}

// ---------------------------------------------------------------------------
// Procesamiento del outbox
// ---------------------------------------------------------------------------
export interface SyncResult {
  status: "ok" | "idle" | "busy" | "not_configured" | "error";
  jobs: number;
  appended: number;
  updated: number;
  removed: number;
  error?: string;
}

export interface SyncOptions {
  trigger: string;
  batchSize?: number;
  maxBatches?: number;
  /** Cuánto esperar si otro proceso está sincronizando. */
  waitForLeaseMs?: number;
}

export async function runSheetSync(opts: SyncOptions): Promise<SyncResult> {
  const empty: SyncResult = { status: "idle", jobs: 0, appended: 0, updated: 0, removed: 0 };
  let client: SheetsClient | null;
  try {
    client = getSheetsClient();
  } catch (err) {
    console.error("[sheets] configuración inválida:", safeError(err));
    return { ...empty, status: "error", error: safeError(err) };
  }
  if (!client) return { ...empty, status: "not_configured" };

  const due = await getDb().query<{ n: number }>(
    "SELECT count(*) AS n FROM app.sheet_sync_jobs WHERE status = 'pending' AND next_attempt_at <= now()",
  );
  if (due.rows[0].n === 0) return empty;

  const leased = await withLease(120, opts.waitForLeaseMs ?? 0, async () => {
    const total: SyncResult = { ...empty, status: "ok" };
    for (let batch = 0; batch < (opts.maxBatches ?? 5); batch++) {
      const r = await syncBatch(client!, opts.trigger, opts.batchSize ?? 300);
      total.jobs += r.jobs;
      total.appended += r.appended;
      total.updated += r.updated;
      total.removed += r.removed;
      if (r.status === "error") return { ...total, status: "error" as const, error: r.error };
      if (r.status === "idle") break;
    }
    return total.jobs === 0 ? { ...total, status: "idle" as const } : total;
  });
  return leased.acquired ? leased.value : { ...empty, status: "busy" };
}

async function syncBatch(client: SheetsClient, trigger: string, batchSize: number): Promise<SyncResult> {
  const db = getDb();
  const { rows: jobs } = await db.query<{ id: number; invitation_id: string; email_normalized: string }>(
    `SELECT id, invitation_id, email_normalized FROM app.sheet_sync_jobs
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY id LIMIT $1`,
    [batchSize],
  );
  if (jobs.length === 0) return { status: "idle", jobs: 0, appended: 0, updated: 0, removed: 0 };

  const maxId = jobs[jobs.length - 1].id;
  const emails = [...new Set(jobs.map((j) => j.email_normalized))];
  const run = await db.query<{ id: number }>(
    "INSERT INTO app.sync_runs (trigger, jobs) VALUES ($1, $2) RETURNING id",
    [trigger, jobs.length],
  );
  const runId = run.rows[0].id;

  try {
    // El estado deseado se lee DESPUÉS de tomar las tareas: refleja todo lo que ellas representan.
    const desired = await loadDesired(emails);
    await client.ensureSheet();
    const sheetRows = await client.readRows();
    const plan = planSheetChanges(sheetRows, desired, new Set(emails));
    await applyPlan(client, plan);

    // Se marcan completadas solo cuando Google confirmó todas las escrituras.
    const done = await db.query<{ invitation_id: string }>(
      `UPDATE app.sheet_sync_jobs
          SET status = 'done', completed_at = now(), last_error = NULL
        WHERE status = 'pending' AND id <= $1 AND email_normalized = ANY($2::text[])
        RETURNING invitation_id`,
      [maxId, emails],
    );
    await db.query(
      `UPDATE app.invitations SET sync_status = 'synced', synced_at = now()
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM app.sheet_sync_jobs j
             WHERE j.invitation_id = app.invitations.id AND j.status = 'pending'
          )`,
      [[...new Set(done.rows.map((r) => r.invitation_id))]],
    );
    const result: SyncResult = {
      status: "ok",
      jobs: done.rowCount ?? jobs.length,
      appended: plan.appends.length,
      updated: plan.updates.length,
      removed: plan.deletes.length,
    };
    await db.query(
      `UPDATE app.sync_runs SET finished_at = now(), ok = true, appended = $2, updated = $3, removed = $4
        WHERE id = $1`,
      [runId, result.appended, result.updated, result.removed],
    );
    return result;
  } catch (err) {
    const message = safeError(err);
    console.error("[sheets] falló la sincronización:", message);
    const ids = jobs.map((j) => j.id);
    await db.query(
      `UPDATE app.sheet_sync_jobs
          SET attempts = attempts + 1,
              last_error = $2,
              next_attempt_at = now() + make_interval(secs => LEAST(1800, 15 * power(2, LEAST(attempts, 10))))
        WHERE id = ANY($1::bigint[])`,
      [ids, message],
    );
    await db.query(
      `UPDATE app.invitations SET sync_status = 'error'
        WHERE id = ANY($1::uuid[]) AND sync_status <> 'synced'`,
      [[...new Set(jobs.map((j) => j.invitation_id))]],
    );
    await db.query("UPDATE app.sync_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1", [
      runId,
      message,
    ]);
    return { status: "error", jobs: jobs.length, appended: 0, updated: 0, removed: 0, error: message };
  }
}

// ---------------------------------------------------------------------------
// Diagnóstico y reconciliación completa
// ---------------------------------------------------------------------------
export interface SheetDiagnosis {
  sheetRows: number;
  dbActive: number;
  missingInSheet: string[];
  extraInSheet: Array<{ rowNumber: number; guest: string }>;
  duplicates: Array<{ email: string; rows: number[] }>;
  wrongInviter: Array<{ email: string; rowNumber: number; sheet: string; expected: string }>;
  ignoredRows: number;
  plan: SheetPlan;
}

export async function diagnoseSheet(): Promise<SheetDiagnosis> {
  const client = getSheetsClient();
  if (!client) throw new Error("Google Sheets no está configurado");
  const desired = await loadDesired(null);
  await client.ensureSheet();
  const rows = await client.readRows();
  const byEmail = new Map<string, SheetRow[]>();
  let ignored = 0;
  for (const r of rows) {
    const k = normalizeEmail(r.guest);
    if (!k) {
      if (r.guest.trim() || r.invitedBy.trim()) ignored++;
      continue;
    }
    byEmail.set(k, [...(byEmail.get(k) ?? []), r]);
  }
  const diag: SheetDiagnosis = {
    sheetRows: rows.filter((r) => r.guest.trim() || r.invitedBy.trim()).length,
    dbActive: desired.size,
    missingInSheet: [],
    extraInSheet: [],
    duplicates: [],
    wrongInviter: [],
    ignoredRows: ignored,
    plan: planSheetChanges(rows, desired, null),
  };
  for (const [email, want] of desired) {
    const ex = byEmail.get(email);
    if (!ex) diag.missingInSheet.push(email);
    else if (ex[0].invitedBy !== want.invitedBy) {
      diag.wrongInviter.push({ email, rowNumber: ex[0].rowNumber, sheet: ex[0].invitedBy, expected: want.invitedBy });
    }
  }
  for (const [email, list] of byEmail) {
    if (!desired.has(email)) diag.extraInSheet.push(...list.map((r) => ({ rowNumber: r.rowNumber, guest: r.guest })));
    else if (list.length > 1) diag.duplicates.push({ email, rows: list.map((r) => r.rowNumber) });
  }
  return diag;
}

/**
 * Reconciliación completa: hace que la hoja coincida exactamente con las
 * invitaciones activas de PostgreSQL. Agrega faltantes, corrige "Invitado por",
 * elimina duplicados y filas de invitaciones que ya no existen.
 * Nunca toca la base de datos de invitaciones (solo marca tareas como completadas).
 */
export async function reconcileSheet(trigger: string): Promise<SyncResult> {
  const client = getSheetsClient();
  if (!client) return { status: "not_configured", jobs: 0, appended: 0, updated: 0, removed: 0 };
  const leased = await withLease(300, 10_000, async (): Promise<SyncResult> => {
    const db = getDb();
    const maxJob = await db.query<{ max: number | null }>(
      "SELECT max(id) AS max FROM app.sheet_sync_jobs WHERE status = 'pending'",
    );
    const run = await db.query<{ id: number }>(
      "INSERT INTO app.sync_runs (trigger) VALUES ($1) RETURNING id",
      [`reconcile:${trigger}`],
    );
    try {
      const desired = await loadDesired(null);
      await client.ensureSheet();
      const rows = await client.readRows();
      const plan = planSheetChanges(rows, desired, null);
      await applyPlan(client, plan);
      let jobs = 0;
      if (maxJob.rows[0].max !== null) {
        const done = await db.query<{ invitation_id: string }>(
          `UPDATE app.sheet_sync_jobs SET status = 'done', completed_at = now(), last_error = NULL
            WHERE status = 'pending' AND id <= $1 RETURNING invitation_id`,
          [maxJob.rows[0].max],
        );
        jobs = done.rowCount ?? 0;
      }
      await db.query(
        `UPDATE app.invitations i SET sync_status = 'synced', synced_at = now()
          WHERE sync_status <> 'synced'
            AND NOT EXISTS (SELECT 1 FROM app.sheet_sync_jobs j WHERE j.invitation_id = i.id AND j.status = 'pending')`,
      );
      await db.query(
        `UPDATE app.sync_runs SET finished_at = now(), ok = true, jobs = $2, appended = $3, updated = $4, removed = $5
          WHERE id = $1`,
        [run.rows[0].id, jobs, plan.appends.length, plan.updates.length, plan.deletes.length],
      );
      return { status: "ok", jobs, appended: plan.appends.length, updated: plan.updates.length, removed: plan.deletes.length };
    } catch (err) {
      const message = safeError(err);
      await db.query("UPDATE app.sync_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1", [
        run.rows[0].id,
        message,
      ]);
      return { status: "error", jobs: 0, appended: 0, updated: 0, removed: 0, error: message };
    }
  });
  return leased.acquired ? leased.value : { status: "busy", jobs: 0, appended: 0, updated: 0, removed: 0 };
}

/** Reintenta YA todas las tareas pendientes (ignora la espera progresiva). */
export async function makeAllPendingDue(): Promise<number> {
  const r = await getDb().query(
    "UPDATE app.sheet_sync_jobs SET next_attempt_at = now() WHERE status = 'pending' AND next_attempt_at > now()",
  );
  return r.rowCount ?? 0;
}
