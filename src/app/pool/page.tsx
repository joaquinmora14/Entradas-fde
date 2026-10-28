import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { PoolAddForm } from "@/components/pool-add-form";
import { PoolPickList } from "@/components/pool-pick-list";
import { Alert, Badge, Card, EmptyState, PageTitle, Stat, SyncBadge, formatDateTime } from "@/components/ui";
import { addEmailsToPoolAction, checkPoolEmailsAction, poolInviteAction, removeFromPoolAction } from "@/app/actions/invite";
import { requireActor } from "@/lib/session";
import { getDashboard } from "@/server/invitations";
import { getPoolBoard } from "@/server/pool-admin";

export const metadata: Metadata = { title: "Personas fuera de lista" };

export default async function PoolPage() {
  const actor = await requireActor();
  if (!actor.isGraduate) redirect("/admin/pool");
  const [d, board] = await Promise.all([getDashboard(actor), getPoolBoard(actor)]);
  const mine = d.invitations.filter((i) => i.source === "pool");
  return (
    <div className="space-y-5">
      <PageTitle
        title="Personas fuera de lista"
        subtitle="Lista común de gente que quiere venir y todavía no tiene entrada. Todos los egresados la ven y pueden sumar gente. Si querés darle una de tus entradas a alguien de la lista, elegilo: se descuenta de tus entradas personales."
      />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="En la lista" value={<span data-testid="pool-available">{d.poolAvailable}</span>} />
        <Stat label="Tus entradas" value={`${d.quota.remaining} / ${d.quota.initial}`} tone="brand" hint="Dar una de la lista usa 1." />
        <Stat label="Diste desde la lista" value={d.poolInvitedByMe} />
      </div>

      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Lista de fuera de lista</h2>
          <Badge tone="brand">Más antiguos primero</Badge>
        </div>
        <p className="mb-2 text-sm text-slate-600">Tocá “Darle mi entrada” en la persona que elijas. Después copiá su mail para mandárselo.</p>
        {d.quota.remaining <= 0 ? (
          <div className="mb-2">
            <Alert tone="info">Ya usaste todas tus entradas: podés ver la lista y sumar gente, pero no darles entrada.</Alert>
          </div>
        ) : null}
        <PoolPickList people={board.available} remaining={d.quota.remaining} pick={poolInviteAction} remove={removeFromPoolAction} />
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold">Les diste entrada desde la lista</h2>
        {mine.length === 0 ? (
          <EmptyState title="Todavía no le diste entrada a nadie de la lista" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {mine.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <p className="select-all break-all font-semibold">{i.email}</p>
                  <p className="text-xs text-slate-500">{formatDateTime(i.createdAt)}</p>
                </div>
                <CopyButton text={i.email} />
                <SyncBadge sync={i.sync} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Sumar gente a la lista</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pegá la lista tal como te llegó (nombre, mail, DNI…). Se toman solo los mails. No se agregan los que ya están en la
          lista ni los que ya tienen entrada. Sumar a alguien no le da entrada: queda en la lista para que un egresado lo elija.
        </p>
        <div className="mt-3">
          <PoolAddForm check={checkPoolEmailsAction} add={addEmailsToPoolAction} />
        </div>
      </Card>

      {board.assigned.length ? (
        <Card>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">Ya tienen entrada desde la lista ({board.assigned.length})</summary>
            <ul className="mt-2 divide-y divide-slate-200">
              {board.assigned.map((p) => (
                <li key={p.email} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="break-all">{p.email}</span>
                  <span className="text-xs text-slate-500">Se la dio {p.invitedBy}</span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      ) : null}
    </div>
  );
}
