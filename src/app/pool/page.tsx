import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { PoolInviteButton } from "@/components/pool-button";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, EmptyState, PageTitle, Stat, SyncBadge, dangerButtonClass, formatDateTime, inputClass } from "@/components/ui";
import { addToPoolAction, removeFromPoolAction } from "@/app/actions/invite";
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
        subtitle="Lista común de gente que quiere venir y todavía no tiene entrada. Cualquier egresado puede sumar gente y cualquiera puede invitarla. Al tocar el botón se te asigna la próxima persona disponible (por orden de carga). No usa tus entradas individuales."
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Disponibles en el pool" value={<span data-testid="pool-available">{d.poolAvailable}</span>} tone="brand" />
        <Stat label="Invitaste desde el pool" value={d.poolInvitedByMe} />
        <Stat label="Tus entradas individuales" value={`${d.quota.remaining} / ${d.quota.initial}`} hint="No cambian al invitar del pool." />
      </div>

      <Card>
        {d.poolAvailable === 0 ? (
          <div className="mb-4">
            <EmptyState title="No quedan personas disponibles">Podés sumar gente abajo.</EmptyState>
          </div>
        ) : null}
        <PoolInviteButton available={d.poolAvailable} />
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Sumar gente a la lista</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pegá la lista tal como te llegó (nombre, mail, DNI…). Se toman solo los mails. No se agregan los que ya están en la
          lista ni los que ya tienen entrada. Sumar a alguien no le da entrada: queda disponible para que un egresado lo invite.
        </p>
        <ActionForm action={addToPoolAction} className="mt-3" resetOnSuccess view="import-report">
          <textarea
            name="text"
            rows={4}
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
            placeholder={"Juan Pérez - juan@gmail.com - 40123456\nAna López, ana@hotmail.com, 41222333"}
          />
          <SubmitButton pendingText="Agregando…">Agregar a la lista</SubmitButton>
        </ActionForm>
      </Card>

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Lista de fuera de lista</h2>
          <Badge tone="brand">{board.available.length} disponibles</Badge>
        </div>
        {board.available.length === 0 ? (
          <EmptyState title="La lista está vacía" />
        ) : (
          <ol className="divide-y divide-slate-100">
            {board.available.map((p, idx) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="break-all font-medium">
                    <span className="mr-2 text-xs tabular-nums text-slate-400">{idx + 1}.</span>
                    {p.email}
                  </p>
                  <p className="text-xs text-slate-500">
                    {p.mine ? "La cargaste vos" : p.addedBy ? `Cargada por ${p.addedBy}` : "Cargada"} · {formatDateTime(p.addedAt)}
                  </p>
                </div>
                {p.mine ? (
                  <ActionForm action={removeFromPoolAction} hidden={{ id: p.id }} confirm="¿Quitar a esta persona de la lista?">
                    <SubmitButton className={dangerButtonClass}>Quitar</SubmitButton>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {board.assigned.length ? (
          <details className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">Ya invitados desde la lista ({board.assigned.length})</summary>
            <ul className="mt-2 divide-y divide-slate-200">
              {board.assigned.map((p) => (
                <li key={p.email} className="flex flex-wrap justify-between gap-2 py-1.5">
                  <span className="break-all">{p.email}</span>
                  <span className="text-xs text-slate-500">Invitado por {p.invitedBy}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
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
