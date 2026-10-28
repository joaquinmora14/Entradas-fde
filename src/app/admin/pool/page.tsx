import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, EmptyState, PageTitle, Stat, dangerButtonClass, formatDateTime, inputClass, secondaryButtonClass } from "@/components/ui";
import { importPoolAction, poolPersonAction } from "@/app/actions/admin";
import { addEmailsToPoolAction, checkPoolEmailsAction } from "@/app/actions/invite";
import { PoolAddForm } from "@/components/pool-add-form";
import { getCurrentActor } from "@/lib/session";
import { listPool, poolStats, type PoolPersonRow } from "@/server/pool-admin";

export const metadata: Metadata = { title: "Pool" };

const reasons: Record<string, string> = {
  admin: "desactivada por un administrador",
  invited_directly: "fue invitada con una entrada individual",
  already_invited: "ya estaba invitada",
  invitation_cancelled: "su invitación fue anulada",
};

/** Junta las filas por grupo, respetando el orden (los grupos más antiguos primero). */
function groupRows(rows: PoolPersonRow[]) {
  const map = new Map<string, { id: string; rows: PoolPersonRow[] }>();
  for (const r of rows) {
    const g = map.get(r.groupId) ?? { id: r.groupId, rows: [] };
    g.rows.push(r);
    map.set(r.groupId, g);
  }
  return [...map.values()];
}

export default async function PoolAdminPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const actor = await getCurrentActor();
  const [rows, stats] = await Promise.all([listPool(actor, status), poolStats()]);
  return (
    <div className="space-y-5">
      <PageTitle title="Personas fuera de lista" subtitle="Pool común, por grupos (las personas de un mismo mensaje van juntas). Los egresados eligen un grupo y les dan entrada a todos; los más antiguos aparecen primero." />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Disponibles" value={stats.available} tone="brand" />
        <Stat label="Asignadas" value={stats.assigned} />
        <Stat label="Retiradas" value={stats.retired} />
      </div>
      <Card>
        <h2 className="text-lg font-semibold">Agregar personas</h2>
        <p className="mt-1 text-sm text-slate-600">Pegá la lista tal como te llegó (nombre, mail, DNI… en cualquier formato): se toman solo los mails y antes de agregar ves cuáles ya están o ya tienen entrada. Agregar al pool no crea filas en la planilla: solo aparecen cuando alguien las invita.</p>
        <div className="mt-3 space-y-3">
          <PoolAddForm check={checkPoolEmailsAction} add={addEmailsToPoolAction} />
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">O subir un archivo CSV (cada persona queda sola, sin grupo)</summary>
            <ActionForm action={importPoolAction} className="mt-2" resetOnSuccess view="import-report">
              <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" className="text-sm" required />
              <SubmitButton pendingText="Agregando…">Agregar desde el archivo</SubmitButton>
            </ActionForm>
          </details>
        </div>
      </Card>
      <Card>
        <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
          <select name="status" defaultValue={status ?? ""} className={`${inputClass} max-w-56`}>
            <option value="">Todas</option>
            <option value="available">Disponibles</option>
            <option value="assigned">Asignadas</option>
            <option value="retired">Retiradas</option>
          </select>
          <button type="submit" className={secondaryButtonClass}>
            Filtrar
          </button>
        </form>
        {rows.length === 0 ? (
          <EmptyState title="No hay personas en el pool" />
        ) : (
          <div className="space-y-3">
            {groupRows(rows).map((g) => (
              <div key={g.id} className="rounded-2xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={g.rows.length > 1 ? "brand" : "slate"}>{g.rows.length === 1 ? "1 persona" : `Grupo de ${g.rows.length}`}</Badge>
                  <span className="text-xs text-slate-500">Cargado {formatDateTime(g.rows[0].addedAt)}</span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {g.rows.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                      <div className="min-w-0">
                        <p className="break-all font-medium">{p.email}</p>
                        <p className="text-xs text-slate-500">
                          {p.status === "assigned" && p.assignedAt
                            ? `Invitada por ${p.assignedTo} · ${formatDateTime(p.assignedAt)}`
                            : p.status === "retired"
                              ? `Retirada: ${reasons[p.retiredReason ?? ""] ?? p.retiredReason ?? ""}`
                              : "Disponible"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {p.status === "available" ? <Badge tone="green">Disponible</Badge> : p.status === "assigned" ? <Badge tone="brand">Asignada</Badge> : <Badge>Retirada</Badge>}
                        {p.status === "available" ? (
                          <>
                            <ActionForm action={poolPersonAction} hidden={{ id: p.id, op: "retire" }}>
                              <SubmitButton className={secondaryButtonClass}>Desactivar</SubmitButton>
                            </ActionForm>
                            <ActionForm action={poolPersonAction} hidden={{ id: p.id, op: "delete" }} confirm="¿Eliminar a esta persona del pool?">
                              <SubmitButton className={dangerButtonClass}>Eliminar</SubmitButton>
                            </ActionForm>
                          </>
                        ) : null}
                        {p.status === "retired" && p.retiredReason === "admin" ? (
                          <ActionForm action={poolPersonAction} hidden={{ id: p.id, op: "reactivate" }}>
                            <SubmitButton className={secondaryButtonClass}>Reactivar</SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
