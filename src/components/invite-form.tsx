"use client";

import { useActionState, useRef } from "react";
import { inviteAction } from "@/app/actions/invite";
import type { InviteOutcome } from "@/server/invitations";
import { SubmitButton } from "./submit-button";
import { Alert, inputClass } from "./ui";

function ResultMessage({ r }: { r: InviteOutcome }) {
  switch (r.kind) {
    case "created":
      return r.sync === "synced" ? (
        <Alert tone="success" title="¡Invitación registrada!">
          <strong>{r.email}</strong> ya está invitado/a y figura en la planilla. Te quedan {r.remaining}{" "}
          {r.remaining === 1 ? "entrada" : "entradas"}.
        </Alert>
      ) : (
        <Alert tone="warning" title="Invitación registrada · planilla pendiente">
          <strong>{r.email}</strong> quedó invitado/a y la entrada está guardada. La planilla de Google se actualizará
          automáticamente en unos minutos. Te quedan {r.remaining} {r.remaining === 1 ? "entrada" : "entradas"}.
        </Alert>
      );
    case "duplicate":
      return (
        <Alert tone="error" title="Esa persona ya está invitada">
          {r.email} ya fue invitado/a por otro egresado (o por vos). No se descontó ninguna entrada.
        </Alert>
      );
    case "quota_exhausted":
      return (
        <Alert tone="error" title="No te quedan entradas">
          Usaste todas tus entradas individuales. Todavía podés invitar desde “Fuera de lista” si hay personas disponibles.
        </Alert>
      );
    case "validation":
      return <Alert tone="error">{r.message}</Alert>;
    case "error":
      return (
        <Alert tone="error" title="No se pudo completar">
          {r.message} No se descontó ninguna entrada.
        </Alert>
      );
  }
}

export function InviteForm({ remaining }: { remaining: number }) {
  // Clave de idempotencia: se conserva mientras la operación no tenga un resultado
  // definitivo (error temporal o corte de red), así reintentar nunca duplica.
  const keyRef = useRef<string | null>(null);
  const [state, action] = useActionState(async (prev: InviteOutcome | null, form: FormData) => {
    keyRef.current ??= crypto.randomUUID();
    form.set("idempotencyKey", keyRef.current);
    const result = await inviteAction(prev, form);
    if (result.kind !== "error") keyRef.current = null;
    return result;
  }, null);

  const disabled = remaining <= 0;
  return (
    <form action={action} className="space-y-3">
      <label htmlFor="guest-email" className="block text-sm font-medium text-slate-700">
        Email de la persona que querés invitar
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="guest-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={disabled}
          placeholder="invitado@email.com"
          className={inputClass}
        />
        <SubmitButton disabled={disabled} pendingText="Registrando…" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-3 font-semibold text-white shadow-sm hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60">
          Confirmar invitación
        </SubmitButton>
      </div>
      {disabled && !state ? (
        <Alert tone="info">Ya usaste tus entradas individuales.</Alert>
      ) : null}
      <div aria-live="polite">{state ? <ResultMessage r={state} /> : null}</div>
    </form>
  );
}
