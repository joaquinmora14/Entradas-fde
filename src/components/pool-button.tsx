"use client";

import { useActionState, useRef } from "react";
import type { PoolOutcome } from "@/server/invitations";
import { poolInviteAction } from "@/app/actions/invite";
import { SubmitButton } from "./submit-button";
import { Alert } from "./ui";

export function PoolInviteButton({ available }: { available: number }) {
  // La clave se reutiliza ante un corte de red: el reintento no asigna otra persona.
  const keyRef = useRef<string | null>(null);
  const [state, action] = useActionState(async (prev: PoolOutcome | null, form: FormData) => {
    keyRef.current ??= crypto.randomUUID();
    form.set("idempotencyKey", keyRef.current);
    const result = await poolInviteAction(prev, form);
    if (result.kind !== "error") keyRef.current = null;
    return result;
  }, null);

  return (
    <form action={action} className="space-y-3">
      <SubmitButton
        disabled={available <= 0}
        pendingText="Asignando…"
        className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-4 text-lg font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        Invitar a alguien del pool
      </SubmitButton>
      <div aria-live="polite">
        {state?.kind === "created" ? (
          state.sync === "synced" ? (
            <Alert tone="success" title="¡Listo! Invitaste a:">
              <p className="text-base font-semibold break-all">{state.email}</p>
              <p className="mt-1">Ya figura en la planilla. No usó ninguna de tus entradas individuales.</p>
            </Alert>
          ) : (
            <Alert tone="warning" title="Invitación registrada · planilla pendiente">
              <p className="text-base font-semibold break-all">{state.email}</p>
              <p className="mt-1">La invitación está guardada; la planilla se actualizará automáticamente en unos minutos.</p>
            </Alert>
          )
        ) : null}
        {state?.kind === "pool_empty" ? (
          <Alert tone="info" title="No quedan personas disponibles">
            Todas las personas fuera de lista ya fueron invitadas.
          </Alert>
        ) : null}
        {state?.kind === "validation" || state?.kind === "error" ? <Alert tone="error">{state.message}</Alert> : null}
      </div>
    </form>
  );
}
