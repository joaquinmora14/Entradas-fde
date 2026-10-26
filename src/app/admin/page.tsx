import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card, PageTitle, Stat, formatDateTime } from "@/components/ui";
import { getCurrentActor } from "@/lib/session";
import { getAdminOverview } from "@/server/admin";

export const metadata: Metadata = { title: "Administración" };

export default async function AdminHome() {
  const o = await getAdminOverview(await getCurrentActor());
  return (
    <div className="space-y-5">
      <PageTitle title="Administración" subtitle="Estado general de las invitaciones." />
      {!o.sheetsConfigured ? (
        <Alert tone="warning" title="Google Sheets no está configurado">
          Las invitaciones se guardan igual y quedan en cola. Ver <Link className="underline" href="/admin/sincronizacion">Planilla</Link>.
        </Alert>
      ) : o.syncFailing > 0 ? (
        <Alert tone="error" title="Hay sincronizaciones con error">
          {o.syncFailing} tareas fallaron y se están reintentando. Ver <Link className="underline" href="/admin/sincronizacion">Planilla</Link>.
        </Alert>
      ) : null}
      {o.graduates === 0 ? (
        <Alert tone="info" title="Cargá la lista de egresados">
          Todavía no hay egresados autorizados. Importalos desde <Link className="underline" href="/admin/egresados">Egresados</Link>.
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Egresados autorizados" value={o.graduates} hint={`${o.registered} registrados · ${o.pendingRegistration} sin registrarse`} />
        <Stat label="Entradas asignadas" value={o.ticketsAssigned} />
        <Stat label="Entradas usadas" value={o.ticketsUsed} />
        <Stat label="Entradas restantes" value={o.ticketsRemaining} tone="brand" />
        <Stat label="Invitados (cupo individual)" value={o.invitationsDirect} />
        <Stat label="Invitados desde el pool" value={o.invitationsPool} />
        <Stat label="Pool disponible" value={o.pool.available} hint={`${o.pool.assigned} asignados · ${o.pool.retired} retirados`} />
        <Stat label="Pendientes de planilla" value={o.syncPending} hint={o.syncOldestPending ? `Desde ${formatDateTime(o.syncOldestPending)}` : "Todo sincronizado"} />
      </div>
      <Card>
        <h2 className="text-lg font-semibold">Integraciones</h2>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          <li>Google Sheets: {o.sheetsConfigured ? "configurado" : "no configurado"}</li>
          <li>
            Última sincronización:{" "}
            {o.lastRun ? `${formatDateTime(o.lastRun.at)} · ${o.lastRun.ok === null ? "en curso" : o.lastRun.ok ? "correcta" : "con error"}` : "nunca"}
          </li>
          <li>Emails de recuperación automáticos: {o.emailEnabled ? "activados" : "desactivados (usá los enlaces desde Egresados)"}</li>
        </ul>
      </Card>
    </div>
  );
}
