"use client";

import { useActionState } from "react";
import { loginAction, registerAction, requestResetAction, resetPasswordAction } from "@/app/actions/auth";
import { initialFormState } from "@/lib/form-state";
import { SubmitButton } from "./submit-button";
import { Alert, Field, inputClass } from "./ui";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(loginAction, initialFormState);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" required className={inputClass} defaultValue={state.fields?.email} placeholder="tu@email.com" />
      </Field>
      <Field label="Contraseña" htmlFor="password">
        <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      <SubmitButton className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60" pendingText="Ingresando…">
        Ingresar
      </SubmitButton>
    </form>
  );
}

export function RegisterForm({ needsCode }: { needsCode: boolean }) {
  const [state, action] = useActionState(registerAction, initialFormState);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      <Field label="Email (el mismo que figura en la lista de egresados)" htmlFor="email">
        <input id="email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" required className={inputClass} defaultValue={state.fields?.email} placeholder="tu@email.com" />
      </Field>
      <Field label="Nombre y apellido" htmlFor="displayName" hint="Es el nombre que se verá en el panel de cupos y en la planilla de invitados.">
        <input id="displayName" name="displayName" autoComplete="name" maxLength={80} className={inputClass} defaultValue={state.fields?.displayName} />
      </Field>
      <Field label="Contraseña" htmlFor="password" hint="Mínimo 8 caracteres.">
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required className={inputClass} />
      </Field>
      <Field label="Repetí la contraseña" htmlFor="passwordConfirm">
        <input id="passwordConfirm" name="passwordConfirm" type="password" autoComplete="new-password" minLength={8} required className={inputClass} />
      </Field>
      {needsCode ? (
        <Field label="Código de registro" htmlFor="registrationCode" hint="Lo compartió la organización en el grupo de egresados.">
          <input id="registrationCode" name="registrationCode" autoComplete="off" autoCapitalize="none" required className={inputClass} />
        </Field>
      ) : null}
      <SubmitButton className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60" pendingText="Creando cuenta…">
        Crear mi cuenta
      </SubmitButton>
    </form>
  );
}

export function RequestResetForm() {
  const [state, action] = useActionState(requestResetAction, initialFormState);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? <Alert tone={state.ok ? "info" : "error"}>{state.message}</Alert> : null}
      <Field label="Email de tu cuenta" htmlFor="email">
        <input id="email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" required className={inputClass} placeholder="tu@email.com" />
      </Field>
      <SubmitButton className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60" pendingText="Enviando…">
        Recuperar acceso
      </SubmitButton>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, initialFormState);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}
      <input type="hidden" name="token" value={token} />
      <Field label="Nueva contraseña" htmlFor="password" hint="Mínimo 8 caracteres.">
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required className={inputClass} />
      </Field>
      <Field label="Repetí la contraseña" htmlFor="passwordConfirm">
        <input id="passwordConfirm" name="passwordConfirm" type="password" autoComplete="new-password" minLength={8} required className={inputClass} />
      </Field>
      <SubmitButton className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60" pendingText="Guardando…">
        Guardar contraseña y entrar
      </SubmitButton>
    </form>
  );
}
