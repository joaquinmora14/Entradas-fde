"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { loginAction, registerAction, requestResetAction, resetPasswordAction } from "@/app/actions/auth";
import { initialFormState } from "@/lib/form-state";
import { SubmitButton } from "./submit-button";
import { Alert, Field, inputClass } from "./ui";

export function LoginForm({ next, email }: { next?: string; email?: string }) {
  const [state, action] = useActionState(loginAction, initialFormState);
  const needsRegister = (state.data as { needsRegister?: boolean } | undefined)?.needsRegister;
  const typed = state.fields?.email ?? email ?? "";
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? (
        <Alert tone={needsRegister ? "warning" : "error"} title={needsRegister ? "Primero tenés que crear tu cuenta" : undefined}>
          {state.message}
          {needsRegister ? (
            <Link
              href={`/registro?email=${encodeURIComponent(typed)}`}
              className="mt-3 block rounded-xl bg-brand-600 px-4 py-3 text-center font-semibold text-white no-underline hover:bg-brand-700"
            >
              Crear mi cuenta
            </Link>
          ) : null}
        </Alert>
      ) : null}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Email" htmlFor="email">
        <input id="email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" required className={inputClass} defaultValue={typed} placeholder="tu@email.com" />
      </Field>
      <Field label="Contraseña" htmlFor="password">
        <PasswordInput autoComplete="current-password" />
      </Field>
      <SubmitButton className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60" pendingText="Ingresando…">
        Ingresar
      </SubmitButton>
    </form>
  );
}

/** Crear cuenta: solo el mail y una contraseña. Después entra directo a su panel. */
export function RegisterForm({ needsCode, email }: { needsCode: boolean; email?: string }) {
  const [state, action] = useActionState(registerAction, initialFormState);
  const alreadyRegistered = (state.data as { alreadyRegistered?: boolean } | undefined)?.alreadyRegistered;
  const typed = state.fields?.email ?? email ?? "";
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message ? (
        <Alert tone={alreadyRegistered ? "info" : "error"}>
          {state.message}
          {alreadyRegistered ? (
            <Link
              href={`/login?email=${encodeURIComponent(typed)}`}
              className="mt-3 block rounded-xl bg-brand-600 px-4 py-3 text-center font-semibold text-white no-underline hover:bg-brand-700"
            >
              Ingresar
            </Link>
          ) : null}
        </Alert>
      ) : null}
      <Field label="Tu mail (el que le diste a Juli)" htmlFor="email">
        <input id="email" name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" required className={inputClass} defaultValue={typed} placeholder="tu@email.com" />
      </Field>
      <Field label="Elegí una contraseña" htmlFor="password" hint="Mínimo 8 caracteres. Con esta contraseña vas a entrar las próximas veces.">
        <PasswordInput autoComplete="new-password" minLength={8} />
      </Field>
      {needsCode ? (
        <Field label="Código de registro" htmlFor="registrationCode" hint="Lo compartió la organización en el grupo de egresados.">
          <input id="registrationCode" name="registrationCode" autoComplete="off" autoCapitalize="none" required className={inputClass} />
        </Field>
      ) : null}
      <SubmitButton className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60" pendingText="Creando cuenta…">
        Crear mi cuenta y entrar
      </SubmitButton>
    </form>
  );
}

/** Campo de contraseña con botón para mostrarla (así no hace falta escribirla dos veces). */
function PasswordInput({ autoComplete, minLength }: { autoComplete: string; minLength?: number }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id="password"
        name="password"
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        minLength={minLength}
        maxLength={128}
        required
        className={`${inputClass} pr-24`}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-pressed={show}
        className="absolute inset-y-1 right-1 rounded-lg px-3 text-sm font-medium text-brand-700 hover:bg-slate-100"
      >
        {show ? "Ocultar" : "Mostrar"}
      </button>
    </div>
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
