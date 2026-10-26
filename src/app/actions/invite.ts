"use server";

import { revalidatePath } from "next/cache";
import { inviteFromPool, inviteGuest, type InviteOutcome, type PoolOutcome } from "@/server/invitations";
import { clientIp, getCurrentActor } from "@/lib/session";

export async function inviteAction(_prev: InviteOutcome | null, form: FormData): Promise<InviteOutcome> {
  const actor = await getCurrentActor();
  if (!actor) return { kind: "validation", message: "Tu sesión venció. Volvé a iniciar sesión." };
  const result = await inviteGuest(actor, {
    email: form.get("email"),
    idempotencyKey: form.get("idempotencyKey"),
    ip: await clientIp(),
  });
  revalidatePath("/panel");
  return result;
}

export async function poolInviteAction(_prev: PoolOutcome | null, form: FormData): Promise<PoolOutcome> {
  const actor = await getCurrentActor();
  if (!actor) return { kind: "validation", message: "Tu sesión venció. Volvé a iniciar sesión." };
  const result = await inviteFromPool(actor, { idempotencyKey: form.get("idempotencyKey"), ip: await clientIp() });
  revalidatePath("/pool");
  revalidatePath("/panel");
  return result;
}
