import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { BulkInviteForm } from "@/components/bulk-invite-form";
import { SubmitButton } from "@/components/submit-button";
import {
  Badge,
  Card,
  EmptyState,
  PageTitle,
  ProgressBar,
  Stat,
  SyncBadge,
  dangerButtonClass,
  formatDateTime,
  inputClass,
  secondaryButtonClass,
} from "@/components/ui";
import {
  adminCheckEmailsAction,
  adminInviteManyAction,
  cancelInvitationAction,
  correctInvitationAction,
} from "@/app/actions/admin";
import { getCurrentActor } from "@/lib/session";
import { getGraduateDetail } from "@/server/admin";
import { isAppError } from "@/server/errors";

export const metadata: Metadata = { title: "Ficha del egresado" };

export default async function GraduateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let d;
  try {
    d = await getGraduateDetail(await getCurrentActor(), id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const name = d.user.displayName ?? d.user.email;
  const active = d.invitations.filter((i) => i.status === "active");
  const cancelled = d.invitations.filter((i) => i.status === "cancelled");
  return (
    <div className="space-y-5">
      <Link href="/admin/egresados" className="text-sm font-medium text-brand-700 hover:underline">
        ← Volver a egresados
      </Link>
      <PageTitle title={name} subtitle={d.user.email}>
        {d.user.status === "active" ? <Badge tone="green">Registrado</Badge> : d.user.status === "pending" ? <Badge tone="amber">Sin registrarse</Badge> : <Badge tone="red">Deshabilitado</Badge>}
      </PageTitle>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Restantes" value={d.remaining} tone="brand" />
        <Stat label="Usadas" value={d.user.used} hint={`de ${d.user.initialQuota}`} />
        <Stat label="Desde la lista" value={d.user.poolInvited} hint="Incluidas en las usadas" />
      </div>
      <ProgressBar value={d.user.used} max={d.user.initialQuota} label="Entradas usadas" />

      {d.user.status !== "disabled" && d.remaining > 0 ? (
        <Card>
          <h2 className="text-lg font-semibold">Anotar entradas en nombre de {name}</h2>
          <p className="mb-3 mt-1 text-sm text-slate-600">Usa el cupo de este egresado y queda registrado en la auditoría como hecho por vos.</p>
          <BulkInviteForm
            check={adminCheckEmailsAction.bind(null, id)}
            submit={adminInviteManyAction.bind(null, id)}
            remaining={d.remaining}
            who={name}
          />
        </Card>
      ) : null}

      <Card>
        <h2 className="mb-2 text-lg font-semibold">Mails anotados ({active.length})</h2>
        {active.length === 0 ? (
          <EmptyState title="Todavía no anotó ningún mail" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {active.map((r) => (
              <li key={r.id} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-medium">{r.email}</p>
                    <p className="text-xs text-slate-500">
                      {formatDateTime(r.createdAt)} · {r.source === "pool" ? "desde el pool" : "entrada individual"}
                    </p>
                  </div>
                  <SyncBadge sync={r.sync} />
                </div>
                <details className="rounded-xl bg-slate-50 p-3 text-sm">
                  <summary className="cursor-pointer font-medium text-slate-700">Corregir</summary>
                  <div className="mt-3 space-y-3">
                    {r.source === "direct" ? (
                      <ActionForm action={correctInvitationAction} hidden={{ invitationId: r.id }} confirm="¿Reemplazar este mail?">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input name="email" type="email" required placeholder="Mail correcto" className={inputClass} />
                          <SubmitButton className={secondaryButtonClass}>Corregir mail</SubmitButton>
                        </div>
                      </ActionForm>
                    ) : null}
                    <ActionForm action={cancelInvitationAction} hidden={{ invitationId: r.id }} confirm="¿Anular esta entrada? Se libera y se quita de la planilla.">
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <input name="reason" required placeholder="Motivo (obligatorio)" className={inputClass} maxLength={300} />
                        <SubmitButton className={dangerButtonClass}>Anular entrada</SubmitButton>
                      </div>
                    </ActionForm>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {cancelled.length ? (
        <Card>
          <h2 className="mb-2 text-lg font-semibold">Anuladas ({cancelled.length})</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {cancelled.map((r) => (
              <li key={r.id} className="py-2">
                <p className="break-all text-slate-500 line-through">{r.email}</p>
                <p className="text-xs text-slate-500">{r.cancelReason}</p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
