import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PoolInviteButton } from "@/components/pool-button";
import { Card, EmptyState, PageTitle, Stat, SyncBadge, formatDateTime } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { getDashboard } from "@/server/invitations";

export const metadata: Metadata = { title: "Personas fuera de lista" };

export default async function PoolPage() {
  const actor = await requireActor();
  if (!actor.isGraduate) redirect("/admin");
  const d = await getDashboard(actor);
  const mine = d.invitations.filter((i) => i.source === "pool");
  return (
    <div className="space-y-5">
      <PageTitle
        title="Personas fuera de lista"
        subtitle="Un pool común de personas que quieren venir y todavía no tienen entrada. Al tocar el botón se te asigna automáticamente la próxima persona disponible (por orden de carga). No usa tus entradas individuales."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Disponibles en el pool" value={<span data-testid="pool-available">{d.poolAvailable}</span>} tone="brand" />
        <Stat label="Invitaste desde el pool" value={d.poolInvitedByMe} />
        <Stat label="Tus entradas individuales" value={`${d.quota.remaining} / ${d.quota.initial}`} hint="No cambian al invitar del pool." />
      </div>
      <Card>
        {d.poolAvailable === 0 ? (
          <div className="mb-4">
            <EmptyState title="No quedan personas disponibles">Cuando la organización cargue más personas, vas a poder invitarlas desde acá.</EmptyState>
          </div>
        ) : null}
        <PoolInviteButton available={d.poolAvailable} />
      </Card>
      <Card>
        <h2 className="mb-3 text-lg font-semibold">Invitaste desde el pool</h2>
        {mine.length === 0 ? (
          <EmptyState title="Todavía no invitaste a nadie del pool" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {mine.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{i.email}</p>
                  <p className="text-xs text-slate-500">{formatDateTime(i.createdAt)}</p>
                </div>
                <SyncBadge sync={i.sync} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
