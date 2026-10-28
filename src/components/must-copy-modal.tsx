"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Ventana obligatoria: tapa toda la pantalla y no se puede cerrar hasta copiar el mail.
 * No se cierra tocando afuera ni con Escape: el único camino es "Copiar mail" y después
 * "Listo, ya lo copié".
 */
export function MustCopyModal({ email, onDone }: { email: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    copyRef.current?.focus();
    const block = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", block, true);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", block, true);
    };
  }, []);

  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(email);
      ok = true;
    } catch {
      // Navegadores sin permiso de portapapeles: se selecciona el texto y se usa el método clásico.
      const input = inputRef.current;
      if (input) {
        input.focus();
        input.select();
        input.setSelectionRange(0, email.length);
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
      }
    }
    setCopied(true);
    setManual(!ok);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="must-copy-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        <p id="must-copy-title" className="text-xl font-extrabold text-slate-900">
          ⚠️ Copiá el mail para mandarle la invitación
        </p>
        <p className="mt-1 text-sm font-semibold text-amber-800">
          La app NO le manda nada a esta persona: se la tenés que mandar VOS a este mail.
        </p>
        <input
          ref={inputRef}
          readOnly
          value={email}
          aria-label="Mail de la persona"
          onFocus={(e) => e.currentTarget.select()}
          className="mt-4 block w-full break-all rounded-xl border-2 border-slate-300 bg-slate-50 px-3 py-3 text-center text-lg font-bold text-slate-900"
        />
        <button
          ref={copyRef}
          type="button"
          onClick={copy}
          className={`mt-3 w-full rounded-xl px-4 py-4 text-lg font-bold text-white shadow-sm transition ${
            copied ? "bg-emerald-600 hover:bg-emerald-700" : "bg-brand-600 hover:bg-brand-700"
          }`}
        >
          {copied ? (manual ? "Seleccionado: mantené apretado para copiar" : "¡Copiado! ✓") : "Copiar mail"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={!copied}
          className="mt-2 w-full rounded-xl border-2 border-slate-300 px-4 py-3 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Listo, ya lo copié
        </button>
        {!copied ? <p className="mt-2 text-center text-xs text-slate-500">Primero tocá “Copiar mail”.</p> : null}
      </div>
    </div>
  );
}
