export type AppErrorCode =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Mensaje seguro para mostrar al usuario: nunca expone detalles técnicos. */
export function publicMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  return "Ocurrió un error temporal. Intentá de nuevo en unos segundos.";
}
