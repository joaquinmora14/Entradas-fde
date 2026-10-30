"use server";

import { revalidatePath } from "next/cache";
import {
  checkGuestEmails,
  inviteFromPool,
  inviteGroup,
  setInvitationsSent,
  type GroupOutcome,
  type PoolOutcome,
} from "@/server/invitations";
import { publicMessage } from "@/server/errors";
import { checkPoolEmails, importPool } from "@/server/pool-admin";
import { clientIp, getCurrentActor } from "@/lib/session";

/** Da una entrada a cada persona de un grupo de "fuera de lista" (todos juntos o ninguno). */
export async function poolInviteAction(poolGroupId: string, idempotencyKey: string): Promise<PoolOutcome> {
  const actor = await getCurrentActor();
  if (!actor) return { kind: "validation", message: "Tu sesión venció. Volvé a iniciar sesión." };
  const result = await inviteFromPool(actor, { poolGroupId, idempotencyKey, ip: await clientIp() });
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

/** Anota un grupo (la lista pegada): todos juntos o ninguno. */
export async function inviteGroupAction(emails: string[], idempotencyKey: string): Promise<GroupOutcome> {
  const actor = await getCurrentActor();
  if (!actor) return { kind: "validation", message: "Tu sesión venció. Volvé a iniciar sesión." };
  const result = await inviteGroup(actor, { emails, idempotencyKey, ip: await clientIp() });
  revalidatePath("/panel");
  revalidatePath("/pool");
  return result;
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

/** Marca o desmarca invitaciones propias como "ya enviadas" (solo una marca personal). */
export async function markSentAction(ids: string[], sent: boolean): Promise<{ ok: boolean; message?: string }> {
  try {
    await setInvitationsSent(await getCurrentActor(), ids, sent);
    revalidatePath("/panel");
    revalidatePath("/pool");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: publicMessage(err) };
  }
}
