import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, EmptyState, PageTitle, dangerButtonClass, inputClass, secondaryButtonClass } from "@/components/ui";
import { importGraduatesAction, userAction } from "@/app/actions/admin";
import { getCurrentActor } from "@/lib/session";
import { listUsers } from "@/server/admin";

export const metadata: Metadata = { title: "Egresados" };

export default async function GraduatesPage() {
  const actor = await getCurrentActor();
  const users = await listUsers(actor);
  return (
    <div className="space-y-5">
      <PageTitle title="Egresados autorizados" subtitle="Solo las personas de esta lista pueden crear una cuenta. Cada egresado recibe 16 entradas." />
      <Card>
        <h2 className="text-lg font-semibold">Importar lista</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pegá la lista o subí un CSV exportado de Excel/Google Sheets con una fila por egresado: <code>email,nombre</code>. El
          nombre es opcional (si falta, lo completa el egresado al registrarse). Importar de nuevo no borra a nadie: agrega los
          nuevos y actualiza los nombres.
        </p>
        <ActionForm action={importGraduatesAction} className="mt-3" resetOnSuccess view="import-report">
          <textarea name="text" rows={6} className={inputClass} placeholder={"email,nombre\nalguien@ejemplo.com,Nombre Apellido"} />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input type="file" name="file" accept=".csv,.txt,text/csv,text/plain" className="text-sm" />
            <SubmitButton pendingText="Importando…">Importar egresados</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Lista ({users.filter((u) => u.isGraduate).length} egresados)</h2>
        </div>
        {users.length === 0 ? (
          <EmptyState title="Todavía no hay egresados cargados" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {users.map((u) => (
              <li key={u.id} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{u.displayName ?? <span className="text-slate-400">(sin nombre)</span>}</p>
                    <p className="truncate text-sm text-slate-500">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {u.isAdmin ? <Badge tone="brand">Admin</Badge> : null}
                    {u.status === "active" ? <Badge tone="green">Registrado</Badge> : u.status === "pending" ? <Badge tone="amber">Sin registrarse</Badge> : <Badge tone="red">Deshabilitado</Badge>}
                    {u.isGraduate ? (
                      <Badge>
                        {u.used}/{u.initialQuota} entradas · {u.poolInvited} del pool
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <details className="rounded-xl bg-slate-50 p-3 text-sm">
                  <summary className="cursor-pointer font-medium text-slate-700">Acciones</summary>
                  <div className="mt-3 space-y-3">
                    <ActionForm action={userAction} hidden={{ userId: u.id, op: "rename" }}>
                      <div className="flex gap-2">
                        <input name="name" defaultValue={u.displayName ?? ""} maxLength={80} placeholder="Nombre y apellido" className={inputClass} />
                        <SubmitButton className={secondaryButtonClass}>Guardar nombre</SubmitButton>
                      </div>
                    </ActionForm>
                    {u.status !== "disabled" ? (
                      <ActionForm action={userAction} hidden={{ userId: u.id, op: "link" }}>
                        <SubmitButton className={secondaryButtonClass}>{u.status === "pending" ? "Generar enlace de activación" : "Generar enlace para nueva contraseña"}</SubmitButton>
                      </ActionForm>
                    ) : null}
                    {u.id !== actor?.id ? (
                      <div className="flex flex-wrap gap-2">
                        {u.status === "disabled" ? (
                          <ActionForm action={userAction} hidden={{ userId: u.id, op: "enable" }}>
                            <SubmitButton className={secondaryButtonClass}>Habilitar cuenta</SubmitButton>
                          </ActionForm>
                        ) : (
                          <ActionForm action={userAction} hidden={{ userId: u.id, op: "disable" }} confirm="¿Deshabilitar esta cuenta? Se cerrarán sus sesiones.">
                            <SubmitButton className={dangerButtonClass}>Deshabilitar</SubmitButton>
                          </ActionForm>
                        )}
                        {u.status === "pending" && u.used === 0 ? (
                          <ActionForm action={userAction} hidden={{ userId: u.id, op: "delete" }} confirm="¿Quitar a esta persona de la lista autorizada?">
                            <SubmitButton className={dangerButtonClass}>Quitar de la lista</SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
