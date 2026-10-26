"use client";

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <details className="rounded-lg bg-slate-50 p-2 text-xs">
      <summary className="cursor-pointer font-medium">
        {title} ({items.length})
      </summary>
      <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto">
        {items.map((x, i) => (
          <li key={i} className="break-all">
            {x}
          </li>
        ))}
      </ul>
    </details>
  );
}

type Item = string | { email?: string; value?: string; reason?: string };

export function ImportReportView({ report }: { report: unknown }) {
  const r = report as Record<string, Item[] | undefined>;
  const fmt = (xs: Item[] | undefined) =>
    (xs ?? []).map((x) => (typeof x === "string" ? x : `${x.email ?? x.value ?? ""}${x.reason ? ` — ${x.reason}` : ""}`));
  return (
    <div className="space-y-1">
      <List title="Agregados" items={fmt(r.added)} />
      <List title="Actualizados" items={fmt(r.updated)} />
      <List title="Duplicados" items={fmt(r.duplicates)} />
      <List title="Inválidos" items={fmt(r.invalid)} />
      <List title="Rechazados por estar ya invitados" items={fmt(r.conflicts)} />
    </div>
  );
}
