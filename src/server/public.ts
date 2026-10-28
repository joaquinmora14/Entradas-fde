import { getDb } from "./db";
import { alphaCompare } from "./sort";

export interface PublicGraduate {
  /** Identificador opaco solo para listas de React (no es el ID interno). */
  key: string;
  name: string;
  used: number;
  remaining: number;
  initial: number;
}

export interface PublicBoard {
  graduates: PublicGraduate[];
  totals: { initial: number; used: number; remaining: number };
  poolAvailable: number;
  updatedAt: string;
}

/**
 * Panel público de cupos. SOLO devuelve nombre público y números:
 * nunca emails (ni de egresados ni de invitados), IDs internos ni datos técnicos.
 */
export async function getPublicBoard(): Promise<PublicBoard> {
  const db = getDb();
  const [{ rows }, pool] = await Promise.all([
    db.query<{ name: string | null; used: number; initial_quota: number }>(
      `SELECT NULLIF(btrim(u.display_name), '') AS name, q.used, q.initial_quota
         FROM app.users u
         JOIN app.invitation_quotas q ON q.user_id = u.id
        WHERE u.is_graduate AND u.status <> 'disabled'
        ORDER BY lower(COALESCE(u.display_name, 'zzz')), q.used`,
    ),
    db.query<{ n: number }>("SELECT count(*) AS n FROM app.pool_people WHERE status = 'available'"),
  ]);
  // Orden alfabético en español (las tildes no mandan al final); sin nombre, al final.
  rows.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || alphaCompare(a.name ?? "", b.name ?? ""));
  const graduates = rows.map((r, i) => ({
    key: String(i),
    name: r.name ?? "Egresado/a (nombre pendiente)",
    used: r.used,
    remaining: r.initial_quota - r.used,
    initial: r.initial_quota,
  }));
  const totals = graduates.reduce(
    (t, g) => ({ initial: t.initial + g.initial, used: t.used + g.used, remaining: t.remaining + g.remaining }),
    { initial: 0, used: 0, remaining: 0 },
  );
  return { graduates, totals, poolAvailable: pool.rows[0].n, updatedAt: new Date().toISOString() };
}
