import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { InvitationGroupCard } from "@/components/invitation-group";
import { PoolAddForm } from "@/components/pool-add-form";
import { PoolPickList } from "@/components/pool-pick-list";
import { Alert, Badge, Card, EmptyState, PageTitle, Stat } from "@/components/ui";
import { addEmailsToPoolAction, checkPoolEmailsAction, poolInviteAction } from "@/app/actions/invite";
import { requireActor } from "@/lib/session";
import { getDashboard } from "@/server/invitations";
import { getPoolBoard } from "@/server/pool-admin";

export const metadata: Metadata = { title: "Personas fuera de lista" };

export default async function PoolPage() {
  const actor = await requireActor();
  if (!actor.isGraduate) redirect("/admin/pool");
  const [d, board] = await Promise.all([getDashboard(actor), getPoolBoard(actor)]);
  const mine = d.groups.filter((g) => g.items[0].source === "pool");
  return (
    <div className="space-y-5">
      <PageTitle
        title="Personas fuera de lista"
        subtitle="Lista común de gente que quiere venir y todavía no tiene entrada. Todos los egresados la ven y pueden sumar gente. La gente pide en grupo y va junta: si elegís un grupo, les das una entrada a todos (se descuentan de tus entradas personales)."
      />
      <div className="grid grid-cols-3 gap-3">
        <Stat label="En la lista" value={<span data-testid="pool-available">{d.poolAvailable}</span>} />
        <Stat label="Tus entradas" value={`${d.quota.remaining} / ${d.quota.initial}`} tone="brand" hint="Un grupo usa 1 por persona." />
        <Stat label="Diste desde la lista" value={d.poolInvitedByMe} />
      </div>

      <Card>
        <h2 className="text-lg font-semibold">Sumar gente a la lista</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pegá el mensaje tal como te llegó (nombre, mail, DNI…). Se toman solo los mails. <strong>Las personas de un mismo
          mensaje quedan juntas como un grupo</strong>: el egresado que lo elija les da entrada a todos. Pegá un mensaje (un
          grupo) por vez. No se agregan los que ya están en la lista ni los que ya tienen entrada.
        </p>
        <div className="mt-3">
          <PoolAddForm check={checkPoolEmailsAction} add={addEmailsToPoolAction} />
        </div>
      </Card>

      <Card>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Lista de fuera de lista</h2>
          <Badge tone="brand">Más antiguos primero</Badge>
        </div>
        <p className="mb-2 text-sm text-slate-600">Elegí un grupo y tocá “Darles mis entradas”: se le da una a cada persona del grupo. Después copiá los mails para mandárselos.</p>
        {d.quota.remaining <= 0 ? (
          <div className="mb-2">
            <Alert tone="info">Ya usaste todas tus entradas: podés ver la lista y sumar gente, pero no darles entrada.</Alert>
          </div>
        ) : null}
        <PoolPickList groups={board.available} remaining={d.quota.remaining} pick={poolInviteAction} />
      </Card>

      <Card>
        <h2 className="mb-3 text-lg font-semibold">Les diste entrada desde la lista</h2>
        {mine.length === 0 ? (
          <EmptyState title="Todavía no le diste entrada a nadie de la lista" />
        ) : (
          <div className="space-y-3">
            {mine.map((g) => (
              <InvitationGroupCard key={g.id} group={g} />
            ))}
          </div>
        )}
      </Card>

      {board.assigned.length ? (
        <Card>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">
              Ya tienen entrada desde la lista ({board.assigned.reduce((n, g) => n + g.emails.length, 0)})
            </summary>
            <ul className="mt-2 divide-y divide-slate-200">
              {board.assigned.map((g) => (
                <li key={g.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="min-w-0 flex-1 break-all">{g.emails.join(", ")}</span>
                  <span className="text-xs text-slate-500">
                    {g.emails.length > 1 ? `Grupo de ${g.emails.length} · ` : ""}Se {g.emails.length > 1 ? "las" : "la"} dio {g.invitedBy}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      ) : null}
    </div>
  );
}
