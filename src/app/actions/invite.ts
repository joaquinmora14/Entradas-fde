"use server";

import { revalidatePath } from "next/cache";
import {
  checkGuestEmails,
  inviteFromPool,
  inviteMany,
  type PoolOutcome,
} from "@/server/invitations";
import { publicMessage } from "@/server/errors";
import { importPool, removeOwnPoolPerson } from "@/server/pool-admin";
import type { FormState } from "@/lib/form-state";
import { clientIp, getCurrentActor } from "@/lib/session";

export async function poolInviteAction(_prev: PoolOutcome | null, form: FormData): Promise<PoolOutcome> {
  const actor = await getCurrentActor();
  if (!actor) return { kind: "validation", message: "Tu sesión venció. Volvé a iniciar sesión." };
  const result = await inviteFromPool(actor, { idempotencyKey: form.get("idempotencyKey"), ip: await clientIp() });
  revalidatePath("/pool");
  revalidatePath("/panel");
  return result;
}

export async function checkEmailsAction(emails: string[]) {
  const actor = await getCurrentActor();
  if (!actor) return { error: "Tu sesión venció. Volvé a iniciar sesión." } as const;
  try {
    return await checkGuestEmails(actor, emails);
  } catch (err) {
    return { error: publicMessage(err) } as const;
  }
}

export async function inviteManyAction(items: Array<{ email: string; idempotencyKey: string }>) {
  const actor = await getCurrentActor();
  if (!actor) return { error: "Tu sesión venció. Volvé a iniciar sesión." } as const;
  try {
    const result = await inviteMany(actor, { items, ip: await clientIp() });
    revalidatePath("/panel");
    return result;
  } catch (err) {
    return { error: publicMessage(err) } as const;
  }
}

/** Cualquier egresado (o admin) agrega personas al pool pegando una lista: se toman solo los mails. */
export async function addToPoolAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    const r = await importPool(await getCurrentActor(), String(form.get("text") ?? ""));
    revalidatePath("/pool");
    revalidatePath("/panel");
    const parts = [`${r.added.length} ${r.added.length === 1 ? "persona agregada" : "personas agregadas"}`];
    if (r.duplicates.length) parts.push(`${r.duplicates.length} ya estaban en el pool o repetidas`);
    if (r.conflicts.length) parts.push(`${r.conflicts.length} ya tienen entrada`);
    if (r.invalid.length) parts.push(`${r.invalid.length} filas sin mail válido`);
    return { ok: r.added.length > 0 || (r.duplicates.length + r.conflicts.length > 0), message: parts.join(", ") + ".", data: r };
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
}

export async function removeFromPoolAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await removeOwnPoolPerson(await getCurrentActor(), String(form.get("id") ?? ""));
    revalidatePath("/pool");
    return { ok: true, message: "Quitada del pool." };
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
}
