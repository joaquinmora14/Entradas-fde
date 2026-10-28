import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { BulkInviteForm } from "@/components/bulk-invite-form";
import { InvitationGroupCard } from "@/components/invitation-group";
import { checkEmailsAction, inviteGroupAction } from "@/app/actions/invite";
import { Alert, Badge, Card, EmptyState, PageTitle, ProgressBar, Stat } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { getDashboard } from "@/server/invitations";
import { runSheetSync } from "@/server/sheets/sync";

export const metadata: Metadata = { title: "Mis entradas" };

export default async function PanelPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireActor();
  if (!actor.isGraduate) redirect("/admin");
  const params = await searchParams;
  const d = await getDashboard(actor);
  // Reintento oportunista de sincronizaciones pendientes, después de responder.
  after(() => runSheetSync({ trigger: "page" }).catch(() => {}));

  return (
    <div className="space-y-5">
      <PageTitle title={`Hola, ${actor.displayName ?? actor.email}`} subtitle="Anotá a quién le diste cada entrada. La app no envía nada: sirve para que ningún mail se repita entre egresados." />
      {params.bienvenida ? <Alert tone="success" title="¡Cuenta creada!">Ya podés anotar a quién le diste tus entradas.</Alert> : null}
      {params.clave ? <Alert tone="success">Tu contraseña se actualizó.</Alert> : null}
      {params.error === "sin-permiso" ? <Alert tone="error">No tenés permisos para entrar a esa sección.</Alert> : null}

      <Card>
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">Entradas individuales disponibles</p>
            <p className="mt-1 text-5xl font-extrabold tabular-nums text-brand-700" data-testid="remaining">
              {d.quota.remaining}
              <span className="text-2xl font-semibold text-slate-400"> / {d.quota.initial}</span>
            </p>
          </div>
          <div className="text-right text-sm text-slate-600">
            <p>
              Usadas: <strong className="tabular-nums">{d.quota.used}</strong>
            </p>
            <p>
              Iniciales: <strong className="tabular-nums">{d.quota.initial}</strong>
            </p>
          </div>
        </div>
        <div className="mt-4">
          <ProgressBar value={d.quota.used} max={d.quota.initial} label="Entradas usadas" />
        </div>
        <div className="mt-5 border-t border-slate-100 pt-5">
          {d.quota.remaining > 0 ? (
            <BulkInviteForm check={checkEmailsAction} submit={inviteGroupAction} remaining={d.quota.remaining} />
          ) : (
            <Alert tone="info" title="Ya anotaste todas tus entradas">
              Si te equivocaste en algún mail, pedile al administrador que lo corrija.
            </Alert>
          )}
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label="Personas en “fuera de lista”" value={d.poolAvailable} hint="Podés elegir un grupo y darles tus entradas." tone="brand" />
        <Stat label="Les diste entrada desde la lista" value={d.poolInvitedByMe} hint={<Link className="font-medium text-brand-700 hover:underline" href="/pool">Ir a “Fuera de lista” →</Link>} />
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Mails que anotaste</h2>
          <Badge>{d.invitations.length}</Badge>
        </div>
        {d.invitations.length === 0 ? (
          <EmptyState title="Todavía no anotaste ningún mail">Pegá la lista arriba y tocá “Revisar mails”.</EmptyState>
        ) : (
          <div className="space-y-3">
            {d.groups.map((g) => (
              <InvitationGroupCard key={g.id} group={g} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
