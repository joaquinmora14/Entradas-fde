"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PoolOutcome } from "@/server/invitations";
import type { FormState } from "@/lib/form-state";
import { ActionForm } from "./action-form";
import { CopyButton } from "./copy-button";
import { MustCopyModal } from "./must-copy-modal";
import { SubmitButton } from "./submit-button";
import { Alert, EmptyState, SendWarning, buttonClass, cx, dangerButtonClass, formatDateTime } from "./ui";

export interface PoolPerson {
  id: string;
  email: string;
  addedBy: string | null;
  mine: boolean;
  addedAt: string;
}

/**
 * Lista de "fuera de lista" (más antiguos primero). El egresado elige a quién darle
 * una de sus entradas; el mail queda a la vista para copiarlo y mandárselo.
 */
export function PoolPickList({
  people,
  remaining,
  pick,
  remove,
}: {
  people: PoolPerson[];
  remaining: number;
  pick: (poolPersonId: string, idempotencyKey: string) => Promise<PoolOutcome>;
  remove: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<PoolOutcome | null>(null);
  const [lastEmail, setLastEmail] = useState("");
  // Ventana obligatoria para copiar el mail después de dar una entrada.
  const [mustCopy, setMustCopy] = useState<string | null>(null);
  // Una clave por persona: si se corta la conexión y se reintenta, no se gasta otra entrada.
  const keys = useRef(new Map<string, string>());

  const give = (p: PoolPerson) => {
    if (
      !window.confirm(
        `¿Darle una de tus entradas a ${p.email}?\nTe quedarían ${remaining - 1} de tus entradas.\n\n⚠️ IMPORTANTE: la app NO le manda nada. Después tenés que mandarle VOS la invitación a ese mail.`,
      )
    )
      return;
    let key = keys.current.get(p.id);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(p.id, key);
    }
    setBusyId(p.id);
    setLastEmail(p.email);
    startTransition(async () => {
      try {
        const r = await pick(p.id, key!);
        if (r.kind !== "error") keys.current.delete(p.id);
        setResult(r);
        if (r.kind === "created") setMustCopy(r.email);
        router.refresh();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {
        setResult({ kind: "error", message: "Se cortó la conexión. Tocá de nuevo: no se va a gastar otra entrada." });
      } finally {
        setBusyId(null);
      }
    });
  };

  return (
    <div className="space-y-3">
      {mustCopy ? <MustCopyModal email={mustCopy} onDone={() => setMustCopy(null)} /> : null}
      <SendWarning />
      <div aria-live="polite">
        {result?.kind === "created" ? (
          <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-900">¡Listo! Le diste tu entrada a:</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 select-all break-all rounded-lg bg-white px-3 py-2 text-lg font-bold text-slate-900">{result.email}</p>
              <CopyButton text={result.email} label="Copiar mail" className="px-3 py-2 text-sm" />
            </div>
            <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-base font-extrabold text-amber-950">
              ⚠️ Ahora mandale VOS la invitación a este mail: la app no le manda nada.
            </p>
            <p className="mt-2 text-sm text-emerald-900">
              Te quedan {result.remaining} {result.remaining === 1 ? "entrada" : "entradas"}.{" "}
              {result.sync === "synced" ? "Ya figura en la planilla." : "Se va a pasar a la planilla en unos minutos (ya está guardado)."}
            </p>
          </div>
        ) : null}
        {result?.kind === "unavailable" ? (
          <Alert tone="error" title="Esa persona ya no está disponible">
            Otro egresado se la acaba de dar ({lastEmail}). No se te descontó ninguna entrada: elegí a otra persona.
          </Alert>
        ) : null}
        {result?.kind === "quota_exhausted" ? <Alert tone="error">No te quedan entradas para dar.</Alert> : null}
        {result?.kind === "validation" || result?.kind === "error" ? <Alert tone="error">{result.message}</Alert> : null}
      </div>

      {people.length === 0 ? (
        <EmptyState title="No hay personas disponibles en la lista">Podés sumar gente abajo.</EmptyState>
      ) : (
        <ol className="divide-y divide-slate-100">
          {people.map((p, idx) => (
            <li key={p.id} className="space-y-2 py-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-400">{idx + 1}.</span>
                <div className="min-w-0 flex-1">
                  <p className="select-all break-all font-semibold text-slate-900">{p.email}</p>
                  <p className="text-xs text-slate-500">
                    {p.mine ? "La cargaste vos" : p.addedBy ? `Cargada por ${p.addedBy}` : "Cargada"} · {formatDateTime(p.addedAt)}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-9">
                <button
                  type="button"
                  onClick={() => give(p)}
                  disabled={pending || remaining <= 0}
                  className={cx(buttonClass, "px-3 py-2 text-sm")}
                >
                  {busyId === p.id ? "Dando…" : "Darle mi entrada"}
                </button>
                <CopyButton text={p.email} />
                {p.mine ? (
                  <ActionForm action={remove} hidden={{ id: p.id }} confirm="¿Quitar a esta persona de la lista?">
                    <SubmitButton className={dangerButtonClass}>Quitar</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
