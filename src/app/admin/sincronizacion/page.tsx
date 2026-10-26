import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, EmptyState, PageTitle, formatDateTime, secondaryButtonClass } from "@/components/ui";
import { syncAction } from "@/app/actions/admin";
import { getCurrentActor } from "@/lib/session";
import { getAdminOverview, getSyncDetails } from "@/server/admin";
import { googleSheetsConfigError, googleSheetsConfigFromEnv } from "@/server/sheets/google";

export const metadata: Metadata = { title: "Planilla" };

export default async function SyncPage() {
  const actor = await getCurrentActor();
  const [o, s] = await Promise.all([getAdminOverview(actor), getSyncDetails(actor)]);
  let serviceAccount: string | null = null;
  try {
    serviceAccount = googleSheetsConfigFromEnv()?.clientEmail ?? null;
  } catch {
    serviceAccount = null;
  }
  const sheetUrl = process.env.GOOGLE_SHEETS_SPREADSHEET_ID
    ? `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_SPREADSHEET_ID}/edit`
    : null;
  return (
    <div className="space-y-5">
      <PageTitle title="Planilla de Google Sheets" subtitle="PostgreSQL es la fuente de verdad; la hoja “Invitados” se actualiza automáticamente con reintentos." />
      {googleSheetsConfigError() ? (
        <Alert tone="error" title="La credencial de Google no es válida">
          {googleSheetsConfigError()}. Volvé a cargar GOOGLE_SERVICE_ACCOUNT_JSON en Vercel con el contenido completo del archivo .json.
        </Alert>
      ) : !o.sheetsConfigured ? (
        <Alert tone="warning" title="No configurado">
          Faltan las variables GOOGLE_SERVICE_ACCOUNT_JSON y GOOGLE_SHEETS_SPREADSHEET_ID. Las invitaciones quedan en cola y se enviarán apenas se configure.
        </Alert>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={o.sheetsConfigured ? "green" : "amber"}>{o.sheetsConfigured ? "Configurado" : "Sin configurar"}</Badge>
          <Badge tone={o.syncPending ? "amber" : "green"}>{o.syncPending} pendientes</Badge>
          {o.syncFailing ? <Badge tone="red">{o.syncFailing} con error</Badge> : null}
          {sheetUrl ? (
            <a href={sheetUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline">
              Abrir planilla
            </a>
          ) : null}
        </div>
        {serviceAccount ? (
          <p className="mt-3 break-all text-sm text-slate-600">
            Cuenta de servicio: <code className="rounded bg-slate-100 px-1">{serviceAccount}</code> (la planilla tiene que estar compartida con este email como Editor).
          </p>
        ) : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <ActionForm action={syncAction} hidden={{ op: "sync" }}>
            <SubmitButton className={secondaryButtonClass} pendingText="Sincronizando…">Sincronizar pendientes ahora</SubmitButton>
          </ActionForm>
          <ActionForm action={syncAction} hidden={{ op: "diagnose" }} view="diagnosis">
            <SubmitButton className={secondaryButtonClass} pendingText="Comparando…">Comparar planilla con la base</SubmitButton>
          </ActionForm>
          <ActionForm action={syncAction} hidden={{ op: "reconcile" }} confirm="La planilla quedará exactamente igual a las invitaciones activas de la base (agrega faltantes, corrige nombres, quita duplicados y filas sin invitación). ¿Continuar?">
            <SubmitButton className={secondaryButtonClass} pendingText="Reconciliando…">Reconciliar planilla</SubmitButton>
          </ActionForm>
        </div>
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-semibold">Tareas pendientes</h2>
        {s.pendingJobs.length === 0 ? (
          <EmptyState title="No hay tareas pendientes" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {s.pendingJobs.map((j) => (
              <li key={j.id} className="py-2">
                <p className="break-all font-medium">
                  {j.kind === "upsert" ? "Agregar" : "Quitar"} {j.email}
                </p>
                <p className="text-xs text-slate-500">
                  Creada {formatDateTime(j.createdAt)} · intentos: {j.attempts} · próximo intento {formatDateTime(j.nextAttemptAt)}
                </p>
                {j.lastError ? <p className="break-all text-xs text-rose-700">{j.lastError}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <h2 className="mb-2 text-lg font-semibold">Últimas ejecuciones</h2>
        {s.runs.length === 0 ? (
          <EmptyState title="Todavía no hubo sincronizaciones" />
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {s.runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p>
                    {formatDateTime(r.startedAt)} · {r.trigger} · {r.jobs} tareas · +{r.appended} / ~{r.updated} / −{r.removed}
                  </p>
                  {r.error ? <p className="break-all text-xs text-rose-700">{r.error}</p> : null}
                </div>
                <Badge tone={r.ok === null ? "amber" : r.ok ? "green" : "red"}>{r.ok === null ? "en curso" : r.ok ? "ok" : "error"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
