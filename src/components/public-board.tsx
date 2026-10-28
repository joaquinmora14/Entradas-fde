"use client";

import { useMemo, useState } from "react";
import type { PublicGraduate } from "@/server/public";
import { EmptyState, inputClass } from "./ui";

type Sort = "remaining-desc" | "remaining-asc" | "name";

function normalize(s: string) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function PublicBoardTable({ graduates }: { graduates: PublicGraduate[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const rows = useMemo(() => {
    const nq = normalize(q.trim());
    const list = nq ? graduates.filter((g) => normalize(g.name).includes(nq)) : [...graduates];
    list.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "es", { sensitivity: "base" })
        : sort === "remaining-desc"
          ? b.remaining - a.remaining || a.name.localeCompare(b.name, "es", { sensitivity: "base" })
          : a.remaining - b.remaining || a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
    );
    return list;
  }, [graduates, q, sort]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-slate-100 p-4 sm:flex-row">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nombre…"
          aria-label="Buscar por nombre"
          className={inputClass}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar" className={`${inputClass} sm:max-w-60`}>
          <option value="name">Orden alfabético (A–Z)</option>
          <option value="remaining-desc">Más entradas disponibles</option>
          <option value="remaining-asc">Menos entradas disponibles</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="p-4">
          <EmptyState title={graduates.length === 0 ? "Todavía no hay egresados cargados" : "No hay resultados para esa búsqueda"} />
        </div>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Egresado</th>
              <th className="px-2 py-2.5 text-right font-medium">Usadas</th>
              <th className="px-4 py-2.5 text-right font-medium">Disponibles</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((g) => (
              <tr key={g.key}>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900">{g.name}</p>
                  <div className="mt-1.5 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${g.initial ? (g.used / g.initial) * 100 : 0}%` }} />
                  </div>
                </td>
                <td className="px-2 py-3 text-right tabular-nums text-slate-600">{g.used}</td>
                <td className="px-4 py-3 text-right text-base font-semibold tabular-nums text-brand-700">
                  {g.remaining}
                  <span className="text-xs font-normal text-slate-400">/{g.initial}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
