"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Ventana obligatoria: tapa toda la pantalla y no se puede cerrar hasta copiar los mails.
 * No se cierra tocando afuera ni con Escape. Los mails se copian de a uno (cada uno con su
 * botón) y "Listo" se habilita recién cuando se copiaron todos.
 */
export function MustCopyModal({ emails, onDone }: { emails: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState<Set<number>>(new Set());
  const [manual, setManual] = useState<Set<number>>(new Set());
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const firstRef = useRef<HTMLButtonElement>(null);
  const many = emails.length > 1;
  const allCopied = copied.size === emails.length;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    firstRef.current?.focus();
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

  const copy = async (idx: number) => {
    const email = emails[idx];
    let ok = false;
    try {
      await navigator.clipboard.writeText(email);
      ok = true;
    } catch {
      // Navegadores sin permiso de portapapeles: se selecciona el texto y se usa el método clásico.
      const input = inputs.current[idx];
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
    setCopied((s) => new Set(s).add(idx));
    setManual((s) => {
      const n = new Set(s);
      if (ok) n.delete(idx);
      else n.add(idx);
      return n;
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="must-copy-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 p-4"
    >
      <div className="flex max-h-full w-full max-w-md flex-col rounded-2xl bg-white p-5 shadow-2xl">
        <p id="must-copy-title" className="text-xl font-extrabold text-slate-900">
          {many ? `⚠️ Copiá los ${emails.length} mails, de a uno, para mandarles la invitación` : "⚠️ Copiá el mail para mandarle la invitación"}
        </p>
        <p className="mt-1 text-sm font-semibold text-amber-800">
          {many
            ? "La app NO les manda nada: se la tenés que mandar VOS a cada uno de estos mails."
            : "La app NO le manda nada a esta persona: se la tenés que mandar VOS a este mail."}
        </p>
        <ul className="mt-4 space-y-2 overflow-y-auto">
          {emails.map((email, idx) => {
            const done = copied.has(idx);
            return (
              <li key={email} className="rounded-xl border-2 border-slate-300 bg-slate-50 p-2">
                <input
                  ref={(el) => {
                    inputs.current[idx] = el;
                  }}
                  readOnly
                  value={email}
                  aria-label={`Mail ${idx + 1}`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="block w-full bg-transparent px-1 py-1 text-center text-base font-bold text-slate-900"
                />
                <button
                  ref={idx === 0 ? firstRef : undefined}
                  type="button"
                  onClick={() => copy(idx)}
                  aria-label={`Copiar ${email}`}
                  className={`mt-1 w-full rounded-lg px-3 py-2.5 text-base font-bold text-white shadow-sm transition ${
                    done ? "bg-emerald-600 hover:bg-emerald-700" : "bg-brand-600 hover:bg-brand-700"
                  }`}
                >
                  {done ? (manual.has(idx) ? "Seleccionado: mantené apretado para copiar" : "¡Copiado! ✓") : "Copiar mail"}
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={onDone}
          disabled={!allCopied}
          className="mt-3 w-full shrink-0 rounded-xl border-2 border-slate-300 px-4 py-3 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {many ? "Listo, ya los copié" : "Listo, ya lo copié"}
        </button>
        {!allCopied ? (
          <p className="mt-2 text-center text-xs text-slate-500">
            {many ? `Copiá cada mail (${copied.size} de ${emails.length}).` : "Primero tocá “Copiar mail”."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
