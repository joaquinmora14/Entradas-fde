"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { InvitationGroup, MyInvitation } from "@/server/invitations";
import { CopyButton } from "./copy-button";
import { RegretInfo } from "./regret-info";
import { Alert, Badge, SyncBadge, cx, formatDateTime } from "./ui";

type MarkSent = (ids: string[], sent: boolean) => Promise<{ ok: boolean; message?: string }>;
type Filter = "all" | "pending" | "sent";

/**
 * Los mails que anotó el egresado, agrupados como los anotó. Cada mail tiene un botón para
 * marcarlo como "ya enviada" (solo una marca personal: no borra ni cambia nada), así no se
 * pierde entre los que ya mandó y los que no.
 */
export function MyInvitationsList({
  groups,
  markSent,
  showFilter = true,
}: {
  groups: InvitationGroup<MyInvitation>[];
  markSent: MarkSent;
  showFilter?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Cambios recién hechos, para que se vean al instante (después se confirman con el servidor).
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");

  const isSent = (i: MyInvitation) => override[i.id] ?? i.sentAt !== null;
  const all = groups.flatMap((g) => g.items);
  const sentCount = all.filter(isSent).length;
  const pendingCount = all.length - sentCount;

  const mark = (ids: string[], sent: boolean) => {
    setError("");
    setOverride((o) => ({ ...o, ...Object.fromEntries(ids.map((id) => [id, sent])) }));
    startTransition(async () => {
      try {
        const r = await markSent(ids, sent);
        if (!r.ok) throw new Error(r.message);
        router.refresh();
      } catch (err) {
        setOverride((o) => {
          const n = { ...o };
          for (const id of ids) delete n[id];
          return n;
        });
        setError((err as Error).message || "No se pudo guardar. Probá de nuevo.");
      }
    });
  };

  const visible = groups
    .map((g) => ({ g, items: g.items.filter((i) => filter === "all" || (filter === "sent") === isSent(i)) }))
    .filter(({ items }) => items.length > 0);

  const chip = (value: Filter, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      aria-pressed={filter === value}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold",
        filter === value ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {label}
      <span className={cx("rounded-full px-1.5 text-xs tabular-nums", filter === value ? "bg-white/25 text-white" : "bg-slate-100 text-slate-600")}>{count}</span>
    </button>
  );

  return (
    <div className="space-y-3">
      {showFilter && all.length > 0 ? (
        <>
          <p data-testid="sent-summary" className={cx("rounded-xl px-3 py-2 text-sm font-semibold", pendingCount ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900")}>
            {pendingCount
              ? `Ya mandaste ${sentCount} de ${all.length}. Te ${pendingCount === 1 ? "falta mandar 1" : `faltan mandar ${pendingCount}`}.`
              : `¡Ya mandaste las ${all.length}!`}
          </p>
          <div role="group" aria-label="Filtrar por enviadas" className="flex flex-wrap gap-2">
            {chip("pending", "Falta mandar", pendingCount)}
            {chip("sent", "Ya enviadas", sentCount)}
            {chip("all", "Todas", all.length)}
          </div>
        </>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600">
          {filter === "pending" ? "¡No te falta mandar ninguna!" : "Todavía no marcaste ninguna como enviada."}
        </p>
      ) : null}
      {visible.map(({ g, items }) => {
        const n = g.items.length;
        const groupSent = g.items.filter(isSent).length;
        const sync = g.items.some((i) => i.sync !== "synced") ? "pending" : "synced";
        const missing = g.items.filter((i) => !isSent(i)).map((i) => i.id);
        return (
          <div key={g.id} data-testid="invitation-group" className="rounded-2xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={n > 1 ? "brand" : "slate"}>{n === 1 ? "1 persona" : `Grupo de ${n}`}</Badge>
              <span className="text-xs text-slate-500">
                {formatDateTime(g.createdAt)} · {g.items[0].source === "pool" ? "Desde fuera de lista" : "Entradas individuales"}
              </span>
              <span className="ml-auto">
                <SyncBadge sync={sync} />
              </span>
            </div>
            {n > 1 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className={cx("font-semibold", groupSent === n ? "text-emerald-700" : "text-slate-600")}>
                  {groupSent === n ? "✓ Mandaste todas" : `Mandaste ${groupSent} de ${n}`}
                </span>
                {missing.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => mark(missing, true)}
                    disabled={pending}
                    className="rounded-lg border border-emerald-300 bg-white px-2.5 py-1 font-semibold text-emerald-800 hover:bg-emerald-50"
                  >
                    Marcar todas como enviadas
                  </button>
                ) : null}
              </div>
            ) : null}
            <ul className="mt-2 divide-y divide-slate-100">
              {items.map((i) => {
                const sent = isSent(i);
                return (
                  <li key={i.id} data-sent={sent ? "1" : "0"} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className={cx("min-w-0 basis-full select-all break-all font-medium sm:basis-0 sm:flex-1", sent ? "text-slate-500" : "text-slate-900")}>
                      {i.email}
                    </span>
                    <CopyButton text={i.email} />
                    <button
                      type="button"
                      onClick={() => mark([i.id], !sent)}
                      disabled={pending}
                      aria-pressed={sent}
                      title={sent ? "Tocá para desmarcar" : undefined}
                      className={cx(
                        "inline-flex shrink-0 items-center rounded-lg border px-2.5 py-1.5 text-xs font-semibold",
                        sent ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                      )}
                    >
                      {sent ? "✓ Enviada" : "Marcar como enviada"}
                    </button>
                  </li>
                );
              })}
            </ul>
            <RegretInfo emails={g.items.map((i) => i.email)} />
          </div>
        );
      })}
    </div>
  );
}
