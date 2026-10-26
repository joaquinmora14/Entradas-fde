"use server";

import { revalidatePath } from "next/cache";
import {
  checkGuestEmails,
  inviteFromPool,
  inviteMany,
  type PoolOutcome,
} from "@/server/invitations";
import { publicMessage } from "@/server/errors";
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
