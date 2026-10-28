"use client";

import type { UnreadableEmail } from "@/lib/extract-emails";

/** Muestra lo que parece un mail pero no se pudo leer, con la corrección sugerida. */
export function UnreadableBox({
  items,
  ignoredLines,
  onUse,
}: {
  items: UnreadableEmail[];
  ignoredLines: number;
  onUse: (item: UnreadableEmail) => void;
}) {
  return (
    <>
      {items.length ? (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            {items.length === 1 ? "Esto parece un mail pero no se puede leer:" : `Estos ${items.length} parecen mails pero no se pueden leer:`}
          </p>
          <ul className="space-y-1.5">
            {items.map((u) => (
              <li key={u.text} className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono text-xs">{u.text}</span>
                {u.suggestion ? (
                  <>
                    <span className="text-xs">→ ¿quisiste decir <strong className="break-all">{u.suggestion}</strong>?</span>
                    <button type="button" onClick={() => onUse(u)} className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs font-medium">
                      Usar este
                    </button>
                  </>
                ) : (
                  <span className="text-xs">Corregilo en el texto y volvé a revisar.</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {ignoredLines > 0 ? (
        <p className="text-xs text-slate-500">
          Se ignoraron {ignoredLines} {ignoredLines === 1 ? "línea" : "líneas"} sin mail (nombres, DNI, etc.). Es normal.
        </p>
      ) : null}
    </>
  );
}
