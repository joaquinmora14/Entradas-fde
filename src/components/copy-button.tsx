"use client";

import { useState } from "react";
import { cx } from "./ui";

/** Copia un texto (p. ej. un mail) al portapapeles para mandarlo fácil. */
export function CopyButton({ text, label = "Copiar", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Navegadores sin permiso de portapapeles: se selecciona a mano.
          window.prompt("Copiá el mail:", text);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition",
        copied ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        className,
      )}
      aria-label={`${label} ${text}`}
    >
      {copied ? "¡Copiado!" : label}
    </button>
  );
}
