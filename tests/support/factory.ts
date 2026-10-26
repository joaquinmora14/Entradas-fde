import { randomUUID } from "node:crypto";
import type { Actor } from "@/server/actor";
import { hashPassword } from "@/server/auth";
import { getDb } from "@/server/db";

let cachedHash: string | null = null;
export const PASSWORD = "contraseña-segura-1";

export async function makeUser(opts: {
  email: string;
  name?: string | null;
  admin?: boolean;
  graduate?: boolean;
  quota?: number;
  status?: "pending" | "active" | "disabled";
}): Promise<Actor> {
  cachedHash ??= await hashPassword(PASSWORD);
  const status = opts.status ?? "active";
  const graduate = opts.graduate ?? true;
  const { rows } = await getDb().query(
    `INSERT INTO app.users (email, display_name, password_hash, is_admin, is_graduate, status, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'active' THEN now() END) RETURNING id`,
    [opts.email, opts.name ?? null, status === "pending" ? null : cachedHash, opts.admin ?? false, graduate, status],
  );
  if (graduate) {
    await getDb().query("INSERT INTO app.invitation_quotas (user_id, initial_quota) VALUES ($1, $2)", [
      rows[0].id,
      opts.quota ?? 16,
    ]);
  }
  return { id: rows[0].id, email: opts.email, displayName: opts.name ?? null, isAdmin: opts.admin ?? false, isGraduate: graduate };
}

export const key = () => randomUUID();

export async function quotaOf(userId: string) {
  const { rows } = await getDb().query("SELECT used, initial_quota FROM app.invitation_quotas WHERE user_id = $1", [userId]);
  return rows[0] as { used: number; initial_quota: number };
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getDb().query(sql, params);
  return Number(rows[0].n);
}
