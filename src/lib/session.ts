import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Actor } from "@/server/actor";
import { createSession, revokeSession, SESSION_TTL_DAYS, validateSessionToken } from "@/server/auth";

const COOKIE = process.env.NODE_ENV === "production" ? "__Host-fde_session" : "fde_session";

/** Usuario de la sesión actual (o null). Se valida contra la base en cada solicitud. */
export const getCurrentActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    return await validateSessionToken(token);
  } catch (err) {
    console.error("[session] no se pudo validar la sesión:", (err as Error).message);
    return null;
  }
});

export async function requireActor(): Promise<Actor> {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  return actor;
}

export async function requireAdminPage(): Promise<Actor> {
  const actor = await requireActor();
  if (!actor.isAdmin) redirect("/panel?error=sin-permiso");
  return actor;
}

export async function startSession(userId: string): Promise<void> {
  const { token } = await createSession(userId);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 3600,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  await revokeSession(token).catch(() => {});
  store.delete(COOKIE);
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || h.get("x-real-ip") || null)?.slice(0, 64) ?? null;
}

/** URL pública base, para enlaces de recuperación. Nunca se toma del header Host en producción. */
export async function baseUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
