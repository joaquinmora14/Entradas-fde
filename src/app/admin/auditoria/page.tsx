import type { Metadata } from "next";
import { Badge, Card, EmptyState, PageTitle, formatDateTime, inputClass, secondaryButtonClass } from "@/components/ui";
import { getCurrentActor } from "@/lib/session";
import { listAuditLogs } from "@/server/admin";

export const metadata: Metadata = { title: "Auditoría" };

const ACTIONS = [
  "invite", "pool_invite", "login", "register", "password_reset", "password_reset_request", "access_link_generated",
  "graduates_import", "pool_import", "pool_retire", "pool_reactivate", "pool_delete", "invitation_cancel",
  "invitation_correct_email", "user_disable", "user_enable", "user_rename", "user_delete_pending",
  "sheet_sync_manual", "sheet_reconcile", "settings_registration_code",
];

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string; q?: string }> }) {
  const { action, q } = await searchParams;
  const logs = await listAuditLogs(await getCurrentActor(), { action: ACTIONS.includes(action ?? "") ? action : undefined, q });
  return (
    <div className="space-y-5">
      <PageTitle title="Auditoría" subtitle="Registro de operaciones (últimas 300)." />
      <Card>
        <form method="get" className="flex flex-col gap-2 sm:flex-row">
          <select name="action" defaultValue={action ?? ""} className={`${inputClass} sm:max-w-64`}>
            <option value="">Todas las acciones</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input name="q" defaultValue={q} placeholder="Buscar por email o detalle…" className={inputClass} type="search" />
          <button className={secondaryButtonClass} type="submit">
            Filtrar
          </button>
        </form>
      </Card>
      <Card>
        {logs.length === 0 ? (
          <EmptyState title="Sin registros" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {logs.map((l) => (
              <li key={l.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={l.result === "success" ? "green" : l.result === "rejected" ? "amber" : "red"}>{l.result}</Badge>
                  <span className="font-mono text-xs">{l.action}</span>
                  <span className="text-xs text-slate-500">{formatDateTime(l.createdAt)}</span>
                </div>
                <p className="mt-0.5 break-all text-xs text-slate-600">
                  {l.actorEmail ?? "—"}
                  {l.ip ? ` · IP ${l.ip}` : ""}
                  {Object.keys(l.details ?? {}).length ? ` · ${JSON.stringify(l.details)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
