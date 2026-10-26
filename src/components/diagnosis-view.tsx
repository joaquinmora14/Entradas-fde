"use client";

import type { SheetDiagnosis } from "@/server/sheets/sync";

export function DiagnosisView({ diag }: { diag: unknown }) {
  const d = diag as SheetDiagnosis;
  const ok = d.missingInSheet.length + d.extraInSheet.length + d.duplicates.length + d.wrongInviter.length === 0;
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm">
      <p>
        Filas en la planilla: <strong>{d.sheetRows}</strong> · Invitaciones activas en la base: <strong>{d.dbActive}</strong>
      </p>
      {ok ? <p className="font-medium text-emerald-700">La planilla coincide exactamente con la base de datos.</p> : null}
      {d.missingInSheet.length ? (
        <details>
          <summary className="cursor-pointer">Faltan en la planilla ({d.missingInSheet.length})</summary>
          <ul className="ml-4 list-disc text-xs">{d.missingInSheet.map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      ) : null}
      {d.duplicates.length ? (
        <details>
          <summary className="cursor-pointer">Duplicados en la planilla ({d.duplicates.length})</summary>
          <ul className="ml-4 list-disc text-xs">{d.duplicates.map((x) => <li key={x.email}>{x.email}: filas {x.rows.join(", ")}</li>)}</ul>
        </details>
      ) : null}
      {d.wrongInviter.length ? (
        <details>
          <summary className="cursor-pointer">“Invitado por” incorrecto ({d.wrongInviter.length})</summary>
          <ul className="ml-4 list-disc text-xs">{d.wrongInviter.map((x) => <li key={x.email}>Fila {x.rowNumber}: {x.email} — dice “{x.sheet}”, debería decir “{x.expected}”</li>)}</ul>
        </details>
      ) : null}
      {d.extraInSheet.length ? (
        <details>
          <summary className="cursor-pointer">En la planilla pero sin invitación activa ({d.extraInSheet.length})</summary>
          <ul className="ml-4 list-disc text-xs">{d.extraInSheet.map((x) => <li key={x.rowNumber}>Fila {x.rowNumber}: {x.guest}</li>)}</ul>
        </details>
      ) : null}
      {d.ignoredRows ? <p className="text-xs text-slate-500">{d.ignoredRows} filas sin un email válido se dejan sin tocar.</p> : null}
      {!ok ? (
        <p className="text-xs text-slate-600">
          “Reconciliar” aplicaría: {d.plan.appends.length} filas nuevas, {d.plan.updates.length} correcciones y {d.plan.deletes.length} filas eliminadas. Las invitaciones de la base no se modifican.
        </p>
      ) : null}
    </div>
  );
}
