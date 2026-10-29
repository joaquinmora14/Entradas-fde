import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Actor } from "@/server/actor";
import { createSession, revokeSession, SESSION_TTL_DAYS, validateSessionToken } from "@/server/auth";

// Las mismas constantes se usan en src/proxy.ts (que renueva las cookies en cada visita).
const COOKIE = process.env.NODE_ENV === "production" ? "__Host-fde_session" : "fde_session";
/** Una segunda cuenta guardada en el mismo navegador (p. ej. admin y egresado), para cambiar sin volver a ingresar. */
const OTHER_COOKIE = process.env.NODE_ENV === "production" ? "__Host-fde_session_2" : "fde_session_2";

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_TTL_DAYS * 24 * 3600,
});

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * Borra una cookie de sesión. Con el prefijo __Host- el navegador solo acepta el borrado si
 * repite Secure y Path=/ (el delete() corto no los manda y el navegador lo ignora).
 */
function clearCookie(store: CookieStore, name: string) {
  store.set(name, "", { ...cookieOptions(), maxAge: 0 });
}

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

/** La otra cuenta guardada en este navegador (si la hay y sigue válida). */
export const getOtherActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(OTHER_COOKIE)?.value;
  if (!token) return null;
  try {
    return await validateSessionToken(token);
  } catch {
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
  const store = await cookies();
  store.set(COOKIE, token, cookieOptions());
  // Si la otra cuenta guardada era esta misma, no hace falta tenerla dos veces.
  const other = store.get(OTHER_COOKIE)?.value;
  if (other) {
    const otherActor = await validateSessionToken(other).catch(() => null);
    if (!otherActor || otherActor.id === userId) clearCookie(store, OTHER_COOKIE);
  }
}

/**
 * Salir: cierra la sesión actual. Si había otra cuenta guardada en este navegador,
 * queda esa abierta (para salir de las dos, se toca Salir otra vez).
 */
export async function endSession(): Promise<"other" | "none"> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  await revokeSession(token).catch(() => {});
  const other = store.get(OTHER_COOKIE)?.value;
  clearCookie(store, OTHER_COOKIE);
  if (other && (await validateSessionToken(other).catch(() => null))) {
    store.set(COOKIE, other, cookieOptions());
    return "other";
  }
  clearCookie(store, COOKIE);
  return "none";
}

/**
 * Cambiar de cuenta sin cerrar la actual: si hay otra cuenta guardada, se intercambian.
 * Si no, la actual queda guardada y se va a ingresar con la otra. Devuelve a dónde ir.
 */
export async function switchAccount(): Promise<"switched" | "login"> {
  const store = await cookies();
  const current = store.get(COOKIE)?.value;
  const other = store.get(OTHER_COOKIE)?.value;
  if (other && (await validateSessionToken(other).catch(() => null))) {
    store.set(COOKIE, other, cookieOptions());
    if (current) store.set(OTHER_COOKIE, current, cookieOptions());
    else clearCookie(store, OTHER_COOKIE);
    return "switched";
  }
  if (current) store.set(OTHER_COOKIE, current, cookieOptions());
  clearCookie(store, COOKIE);
  return "login";
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
