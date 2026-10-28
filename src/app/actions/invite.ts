"use server";

import { revalidatePath } from "next/cache";
import {
  checkGuestEmails,
  inviteFromPool,
  inviteMany,
  type PoolOutcome,
} from "@/server/invitations";
import { publicMessage } from "@/server/errors";
import { checkPoolEmails, importPool, removeOwnPoolPerson } from "@/server/pool-admin";
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

export async function removeFromPoolAction(_prev: FormState, form: FormData): Promise<FormState> {
  try {
    await removeOwnPoolPerson(await getCurrentActor(), String(form.get("id") ?? ""));
    revalidatePath("/pool");
    return { ok: true, message: "Quitada del pool." };
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
}

export async function checkPoolEmailsAction(emails: string[]) {
  try {
    return await checkPoolEmails(await getCurrentActor(), emails);
  } catch (err) {
    return { error: publicMessage(err) } as const;
  }
}

/** Suma al pool una lista ya revisada (un mail por elemento). */
export async function addEmailsToPoolAction(emails: string[]) {
  try {
    const list = Array.isArray(emails) ? emails.slice(0, 200).map((e) => String(e)) : [];
    const report = await importPool(await getCurrentActor(), list.join("\n"));
    revalidatePath("/pool");
    revalidatePath("/panel");
    revalidatePath("/admin", "layout");
    return { report };
  } catch (err) {
    return { error: publicMessage(err) } as const;
  }
}
