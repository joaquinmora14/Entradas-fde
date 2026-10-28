"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PoolOutcome } from "@/server/invitations";
import type { PoolGroup } from "@/server/pool-admin";
import type { FormState } from "@/lib/form-state";
import { ActionForm } from "./action-form";
import { CopyButton } from "./copy-button";
import { MustCopyModal } from "./must-copy-modal";
import { SubmitButton } from "./submit-button";
import { Alert, Badge, EmptyState, SendWarning, buttonClass, cx, dangerButtonClass, formatDateTime } from "./ui";

const entradas = (n: number) => `${n} ${n === 1 ? "entrada" : "entradas"}`;

/**
 * Lista de "fuera de lista" por grupos (más antiguos primero). La gente pide entradas en
 * grupo y van juntos: el egresado elige un grupo y les da una entrada a TODOS (o a ninguno).
 * Los mails quedan a la vista para copiarlos y mandárselos.
 */
export function PoolPickList({
  groups,
  remaining,
  pick,
  remove,
}: {
  groups: PoolGroup[];
  remaining: number;
  pick: (poolGroupId: string, idempotencyKey: string) => Promise<PoolOutcome>;
  remove: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<PoolOutcome | null>(null);
  // Ventana obligatoria para copiar los mails después de dar las entradas.
  const [mustCopy, setMustCopy] = useState<string[] | null>(null);
  // Una clave por grupo: si se corta la conexión y se reintenta, no se gastan otras entradas.
  const keys = useRef(new Map<string, string>());

  const give = (g: PoolGroup) => {
    const n = g.people.length;
    const who = n === 1 ? g.people[0].email : `este grupo de ${n} personas (van juntos: se anotan todos)`;
    if (
      !window.confirm(
        `¿Darle ${n === 1 ? "una de tus entradas" : `${n} de tus entradas, una a cada uno,`} a ${who}?\nTe quedarían ${remaining - n} de tus entradas.\n\n⚠️ IMPORTANTE: la app NO les manda nada. Después tenés que mandarle VOS la invitación a ${n === 1 ? "ese mail" : "cada uno de esos mails"}.`,
      )
    )
      return;
    let key = keys.current.get(g.id);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(g.id, key);
    }
    setBusyId(g.id);
    startTransition(async () => {
      try {
        const r = await pick(g.id, key!);
        if (r.kind !== "error") keys.current.delete(g.id);
        setResult(r);
        if (r.kind === "created") setMustCopy(r.emails);
        router.refresh();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {
        setResult({ kind: "error", message: "Se cortó la conexión. Tocá de nuevo: no se van a gastar otras entradas." });
      } finally {
        setBusyId(null);
      }
    });
  };

  return (
    <div className="space-y-3">
      {mustCopy ? <MustCopyModal emails={mustCopy} onDone={() => setMustCopy(null)} /> : null}
      <SendWarning />
      <div aria-live="polite">
        {result?.kind === "created" ? (
          <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-900">
              ¡Listo! Les diste {entradas(result.emails.length)} a {result.emails.length === 1 ? "esta persona" : "este grupo"}:
            </p>
            <ul className="mt-2 space-y-1.5">
              {result.emails.map((e) => (
                <li key={e} className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 select-all break-all rounded-lg bg-white px-3 py-2 font-bold text-slate-900">{e}</p>
                  <CopyButton text={e} />
                </li>
              ))}
            </ul>
            <p className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-base font-extrabold text-amber-950">
              ⚠️ Ahora mandales VOS la invitación a {result.emails.length === 1 ? "este mail" : "estos mails"}: la app no les manda nada.
            </p>
            <p className="mt-2 text-sm text-emerald-900">
              Te quedan {entradas(result.remaining)}.{" "}
              {result.sync === "synced" ? "Ya figura en la planilla." : "Se va a pasar a la planilla en unos minutos (ya está guardado)."}
            </p>
          </div>
        ) : null}
        {result?.kind === "unavailable" ? (
          <Alert tone="error" title="Ese grupo ya no está disponible">
            Otro egresado se lo acaba de dar. No se te descontó ninguna entrada: elegí otro grupo.
          </Alert>
        ) : null}
        {result?.kind === "quota_exhausted" ? (
          <Alert tone="error" title="No te alcanzan las entradas">
            {result.needed > 0
              ? `El grupo es de ${result.needed} y te ${result.remaining === 1 ? "queda" : "quedan"} ${entradas(result.remaining)}. Van juntos: no se le puede dar entrada solo a una parte. No se te descontó nada.`
              : "No te quedan entradas para dar."}
          </Alert>
        ) : null}
        {result?.kind === "validation" || result?.kind === "error" ? <Alert tone="error">{result.message}</Alert> : null}
      </div>

      {groups.length === 0 ? (
        <EmptyState title="No hay nadie disponible en la lista">Podés sumar gente arriba.</EmptyState>
      ) : (
        <ol className="space-y-3">
          {groups.map((g, idx) => {
            const n = g.people.length;
            const short = n > remaining;
            return (
              <li key={g.id} data-testid="pool-group" className="rounded-2xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold tabular-nums text-slate-400">{idx + 1}.</span>
                  <Badge tone={n > 1 ? "brand" : "slate"}>{n === 1 ? "1 persona" : `Grupo de ${n} · van juntos`}</Badge>
                  <span className="text-xs text-slate-500">
                    {g.mine ? "Lo cargaste vos" : g.addedBy ? `Cargado por ${g.addedBy}` : "Cargado"} · {formatDateTime(g.addedAt)}
                  </span>
                </div>
                <ul className="mt-2 divide-y divide-slate-100">
                  {g.people.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2 py-1.5">
                      <span className="min-w-0 flex-1 select-all break-all font-semibold text-slate-900">{p.email}</span>
                      <CopyButton text={p.email} />
                      {g.mine ? (
                        <ActionForm action={remove} hidden={{ id: p.id }} confirm={`¿Quitar a ${p.email} de la lista?`}>
                          <SubmitButton className={dangerButtonClass}>Quitar</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => give(g)}
                    disabled={pending || short}
                    className={cx(buttonClass, "px-3 py-2 text-sm")}
                  >
                    {busyId === g.id ? "Dando…" : n === 1 ? "Darle mi entrada" : `Darles mis ${n} entradas`}
                  </button>
                </div>
                {short && remaining > 0 ? (
                  <p className="mt-1.5 text-xs font-medium text-slate-600">
                    Te {remaining === 1 ? "queda" : "quedan"} {entradas(remaining)} y el grupo es de {n}: van juntos, no se puede dar solo a una parte.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
