import { AppError } from "./errors";

export interface Actor {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  isGraduate: boolean;
}

export function requireAdmin(actor: Actor | null | undefined): Actor {
  if (!actor) throw new AppError("UNAUTHENTICATED", "Tenés que iniciar sesión.");
  if (!actor.isAdmin) throw new AppError("FORBIDDEN", "No tenés permisos de administrador.");
  return actor;
}

export function requireGraduate(actor: Actor | null | undefined): Actor {
  if (!actor) throw new AppError("UNAUTHENTICATED", "Tenés que iniciar sesión.");
  if (!actor.isGraduate) {
    throw new AppError("FORBIDDEN", "Solo los egresados pueden registrar invitaciones.");
  }
  return actor;
}

export function actorLabel(a: { displayName: string | null; email: string }): string {
  return a.displayName?.trim() || a.email;
}
