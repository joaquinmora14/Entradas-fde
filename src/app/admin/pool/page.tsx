import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, EmptyState, PageTitle, Stat, dangerButtonClass, formatDateTime, inputClass, secondaryButtonClass } from "@/components/ui";
import { importPoolAction, poolPersonAction } from "@/app/actions/admin";
import { getCurrentActor } from "@/lib/session";
import { listPool, poolStats } from "@/server/pool-admin";

export const metadata: Metadata = { title: "Pool" };

const reasons: Record<string, string> = {
  admin: "desactivada por un administrador",
  invited_directly: "fue invitada con una entrada individual",
  already_invited: "ya estaba invitada",
  invitation_cancelled: "su invitación fue anulada",
};

export default async function PoolAdminPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const actor = await getCurrentActor();
  const [rows, stats] = await Promise.all([listPool(actor, status), poolStats()]);
  return (
    <div className="space-y-5">
      <PageTitle title="Personas fuera de lista" subtitle="Pool común. Se asigna por orden de carga (la primera persona cargada es la primera en salir)." />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Disponibles" value={stats.available} tone="brand" />
        <Stat label="Asignadas" value={stats.assigned} />
        <Stat label="Retiradas" value={stats.retired} />
      </div>
      <Card>
        <h2 className="text-lg font-semibold">Agregar personas</h2>
        <p className="mt-1 text-sm text-slate-600">Un email por línea, o subí un CSV (se toma la columna que tenga emails). Agregar al pool no crea filas en la planilla: solo aparecen cuando alguien las invita.</p>
        <ActionForm action={importPoolAction} className="mt-3" resetOnSuccess view="import-report">
          <textarea name="text" rows={5} className={inputClass} placeholder={"persona@ejemplo.com\notra@ejemplo.com"} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" className="text-sm" />
            <SubmitButton pendingText="Agregando…">Agregar al pool</SubmitButton>
          </div>
        </ActionForm>
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
          <ul className="divide-y divide-slate-100">
            {rows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="break-all font-medium">{p.email}</p>
                  <p className="text-xs text-slate-500">
                    {p.status === "assigned" && p.assignedAt
                      ? `Invitada por ${p.assignedTo} · ${formatDateTime(p.assignedAt)}`
                      : p.status === "retired"
                        ? `Retirada: ${reasons[p.retiredReason ?? ""] ?? p.retiredReason ?? ""}`
                        : `Cargada ${formatDateTime(p.addedAt)}`}
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
        )}
      </Card>
    </div>
  );
}
