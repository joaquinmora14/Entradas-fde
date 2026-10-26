import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, EmptyState, PageTitle, SyncBadge, dangerButtonClass, formatDateTime, inputClass, secondaryButtonClass } from "@/components/ui";
import { cancelInvitationAction, correctInvitationAction } from "@/app/actions/admin";
import { getCurrentActor } from "@/lib/session";
import { listInvitations } from "@/server/admin";

export const metadata: Metadata = { title: "Invitaciones" };

export default async function InvitationsAdminPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const { q, status } = await searchParams;
  const rows = await listInvitations(await getCurrentActor(), { q, status });
  return (
    <div className="space-y-5">
      <PageTitle title="Invitaciones" subtitle="Todos los invitados y quién los registró. Las correcciones mantienen el cupo y la planilla consistentes." />
      <Card>
        <form className="flex flex-col gap-2 sm:flex-row" method="get">
          <input name="q" defaultValue={q} placeholder="Buscar por email o egresado…" className={inputClass} type="search" />
          <select name="status" defaultValue={status ?? "active"} className={`${inputClass} sm:max-w-48`}>
            <option value="active">Activas</option>
            <option value="cancelled">Anuladas</option>
            <option value="all">Todas</option>
          </select>
          <button className={secondaryButtonClass} type="submit">
            Filtrar
          </button>
        </form>
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-semibold">{rows.length} resultados</h2>
        {rows.length === 0 ? (
          <EmptyState title="No hay invitaciones para mostrar" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-medium">{r.email}</p>
                    <p className="text-xs text-slate-500">
                      Invitado por <strong>{r.inviter}</strong> · {formatDateTime(r.createdAt)} · {r.source === "pool" ? "pool" : "cupo individual"}
                    </p>
                    {r.cancelReason ? <p className="text-xs text-rose-700">Anulada: {r.cancelReason}</p> : null}
                  </div>
                  <div className="flex gap-1.5">
                    {r.status === "cancelled" ? <Badge tone="red">Anulada</Badge> : null}
                    {r.status === "active" ? <SyncBadge sync={r.sync} /> : r.sync !== "synced" ? <Badge tone="amber">Quitando de la planilla</Badge> : null}
                  </div>
                </div>
                {r.status === "active" ? (
                  <details className="rounded-xl bg-slate-50 p-3 text-sm">
                    <summary className="cursor-pointer font-medium text-slate-700">Corregir</summary>
                    <div className="mt-3 space-y-3">
                      {r.source === "direct" ? (
                        <ActionForm action={correctInvitationAction} hidden={{ invitationId: r.id }} confirm="¿Reemplazar el email de esta invitación?">
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input name="email" type="email" required placeholder="Email correcto" className={inputClass} />
                            <SubmitButton className={secondaryButtonClass}>Corregir email</SubmitButton>
                          </div>
                        </ActionForm>
                      ) : null}
                      <ActionForm action={cancelInvitationAction} hidden={{ invitationId: r.id }} confirm="¿Anular esta invitación? Se libera la entrada y se quita de la planilla.">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input name="reason" required placeholder="Motivo (obligatorio)" className={inputClass} maxLength={300} />
                          <SubmitButton className={dangerButtonClass}>Anular invitación</SubmitButton>
                        </div>
                      </ActionForm>
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
