"use server";

import { redirect } from "next/navigation";
import { authenticate, registerAccount, requestPasswordReset, resetPassword } from "@/server/auth";
import { publicMessage } from "@/server/errors";
import { baseUrl, clientIp, endSession, startSession } from "@/lib/session";
import type { FormState } from "@/lib/form-state";

function safeNext(value: FormDataEntryValue | null): string {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") ? v : "/panel";
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = form.get("email");
  try {
    const actor = await authenticate({ email, password: form.get("password"), ip: await clientIp() });
    await startSession(actor.id);
  } catch (err) {
    return { ok: false, message: publicMessage(err), fields: { email: String(email ?? "") } };
  }
  redirect(safeNext(form.get("next")));
}

export async function registerAction(_prev: FormState, form: FormData): Promise<FormState> {
  const fields = { email: String(form.get("email") ?? ""), displayName: String(form.get("displayName") ?? "") };
  try {
    const actor = await registerAccount({
      email: form.get("email"),
      displayName: form.get("displayName"),
      password: form.get("password"),
      passwordConfirm: form.get("passwordConfirm"),
      registrationCode: form.get("registrationCode"),
      ip: await clientIp(),
    });
    await startSession(actor.id);
  } catch (err) {
    return { ok: false, message: publicMessage(err), fields };
  }
  redirect("/panel?bienvenida=1");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function requestResetAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const { emailSent } = await requestPasswordReset({
      email: form.get("email"),
      baseUrl: await baseUrl(),
      ip: await clientIp(),
    });
    return {
      ok: true,
      message: emailSent
        ? "Si el email corresponde a una cuenta, te enviamos un enlace para crear una nueva contraseña. Revisá también la carpeta de spam."
        : "Pedido registrado. Para recuperar el acceso, pedile al administrador un enlace de recuperación personal (lo genera desde el panel de administración).",
    };
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
}

export async function resetPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const actor = await resetPassword({
      token: form.get("token"),
      password: form.get("password"),
      passwordConfirm: form.get("passwordConfirm"),
      ip: await clientIp(),
    });
    await startSession(actor.id);
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
  redirect("/panel?clave=1");
}
