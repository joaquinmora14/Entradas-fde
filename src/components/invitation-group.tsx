import type { InvitationGroup, MyInvitation } from "@/server/invitations";
import { CopyButton } from "./copy-button";
import { Badge, SyncBadge, formatDateTime } from "./ui";

/** Un grupo de mails anotados juntos (van juntos a la fiesta), con botones para copiarlos. */
export function InvitationGroupCard({ group }: { group: InvitationGroup<MyInvitation> }) {
  const n = group.items.length;
  const sync = group.items.some((i) => i.sync !== "synced") ? "pending" : "synced";
  return (
    <div data-testid="invitation-group" className="rounded-2xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={n > 1 ? "brand" : "slate"}>{n === 1 ? "1 persona" : `Grupo de ${n}`}</Badge>
        <span className="text-xs text-slate-500">
          {formatDateTime(group.createdAt)} · {group.items[0].source === "pool" ? "Desde fuera de lista" : "Entradas individuales"}
        </span>
        <span className="ml-auto">
          <SyncBadge sync={sync} />
        </span>
      </div>
      <ul className="mt-2 divide-y divide-slate-100">
        {group.items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1 select-all break-all font-medium text-slate-900">{i.email}</span>
            <CopyButton text={i.email} />
          </li>
        ))}
      </ul>
    </div>
  );
}
