import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { audit, auditSafe } from "./audit";
import type { Actor } from "./actor";
import { getDb, withTransaction, type Queryable } from "./db";
import { parseEmail } from "./email";
import { AppError } from "./errors";
import { sendEmail, emailEnabled } from "./mailer";

/** La sesión dura 90 días y se renueva sola cada vez que se usa: mientras entres, no vence. */
export const SESSION_TTL_DAYS = 90;
const RESET_TTL_MINUTES = 60 * 24;
const LOGIN_WINDOW_MINUTES = 15;
const MAX_FAILED_LOGINS_PER_EMAIL = 8;
const MAX_FAILED_LOGINS_PER_IP = 40;

// Hash de referencia para igualar tiempos cuando el usuario no existe.
let dummyHash: Promise<string> | null = null;

// ---------------------------------------------------------------------------
// Contraseñas (argon2id, parámetros por defecto de @node-rs/argon2 ≥ OWASP)
// ---------------------------------------------------------------------------
export function validatePassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 8) {
    throw new AppError("VALIDATION", "La contraseña debe tener al menos 8 caracteres.");
  }
  if (password.length > 128) {
    throw new AppError("VALIDATION", "La contraseña no puede superar los 128 caracteres.");
  }
  return password;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function bootstrapAdminEmails(): Set<string> {
  const raw = process.env.BOOTSTRAP_ADMIN_EMAILS ?? "";
  const out = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const p = parseEmail(part);
    if (p.ok) out.add(p.normalized);
  }
  return out;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  is_admin: boolean;
  is_graduate: boolean;
  status: "pending" | "active" | "disabled";
}

function toActor(u: UserRow): Actor {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    isAdmin: u.is_admin,
    isGraduate: u.is_graduate,
  };
}

function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  return n ? n : null;
}

export function validateDisplayName(name: unknown, required: boolean): string | null {
  const n = cleanName(name);
  if (!n) {
    if (required) throw new AppError("VALIDATION", "Ingresá tu nombre y apellido.");
    return null;
  }
  if (n.length > 80) throw new AppError("VALIDATION", "El nombre no puede superar los 80 caracteres.");
  return n;
}

// ---------------------------------------------------------------------------
// Registro autorizado
// ---------------------------------------------------------------------------
export async function getRegistrationCodeHash(db: Queryable = getDb()): Promise<string | null> {
  const { rows } = await db.query<{ value: string | null }>(
    "SELECT value FROM app.settings WHERE key = 'registration_code_hash'",
  );
  return rows[0]?.value || null;
}

function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface RegisterInput {
  email: unknown;
  /** Opcional: el nombre ya viene de la lista de egresados. */
  displayName?: unknown;
  password: unknown;
  /** Opcional: el formulario de registro pide la contraseña una sola vez (con botón "Mostrar"). */
  passwordConfirm?: unknown;
  registrationCode?: unknown;
  ip?: string | null;
}

export async function registerAccount(input: RegisterInput): Promise<Actor> {
  const parsed = parseEmail(input.email);
  if (!parsed.ok) throw new AppError("VALIDATION", parsed.reason);
  const email = parsed.normalized;
  const password = validatePassword(input.password);
  if (input.passwordConfirm !== undefined && input.password !== input.passwordConfirm) {
    throw new AppError("VALIDATION", "Las contraseñas no coinciden.");
  }

  const codeHash = await getRegistrationCodeHash();
  if (codeHash) {
    const code = typeof input.registrationCode === "string" ? input.registrationCode.trim() : "";
    if (!code || !sameHash(sha256(code.toLowerCase()), codeHash)) {
      await auditSafe({ actorEmail: email, action: "register", result: "rejected", ip: input.ip, details: { reason: "bad_code" } });
      throw new AppError("VALIDATION", "El código de registro no es correcto.");
    }
  }

  const passwordHash = await hashPassword(password);
  const isBootstrapAdmin = bootstrapAdminEmails().has(email);

  try {
    return await withTransaction(async (c) => {
      const { rows } = await c.query<UserRow>(
        "SELECT * FROM app.users WHERE email = $1 FOR UPDATE",
        [email],
      );
      let user = rows[0];
      if (!user && isBootstrapAdmin) {
        const ins = await c.query<UserRow>(
          `INSERT INTO app.users (email, is_admin, is_graduate, status)
           VALUES ($1, true, false, 'pending') RETURNING *`,
          [email],
        );
        user = ins.rows[0];
      }
      if (!user) {
        throw new AppError(
          "FORBIDDEN",
          "Ese mail no está en la lista de egresados. Tiene que ser el mismo mail que le diste a Juli. Si es un error, avisale a Juli.",
        );
      }
      if (user.status === "disabled") {
        throw new AppError("FORBIDDEN", "Esta cuenta está deshabilitada. Contactá al administrador.");
      }
      if (user.status === "active" || user.password_hash) {
        throw new AppError("CONFLICT", "Ya creaste tu cuenta con este mail. Ingresá con tu contraseña.");
      }
      const displayName = validateDisplayName(input.displayName, false) ?? user.display_name;
      const upd = await c.query<UserRow>(
        `UPDATE app.users
            SET password_hash = $2, display_name = $3, status = 'active',
                registered_at = now(), updated_at = now(),
                is_admin = is_admin OR $4
          WHERE id = $1
          RETURNING *`,
        [user.id, passwordHash, displayName, isBootstrapAdmin],
      );
      await audit(
        { actorId: user.id, actorEmail: email, action: "register", result: "success", ip: input.ip },
        c,
      );
      return toActor(upd.rows[0]);
    });
  } catch (err) {
    if (err instanceof AppError) {
      await auditSafe({ actorEmail: email, action: "register", result: "rejected", ip: input.ip, details: { reason: err.message } });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Inicio de sesión
// ---------------------------------------------------------------------------
async function tooManyFailures(email: string, ip: string | null | undefined): Promise<boolean> {
  const { rows } = await getDb().query<{ by_email: number; by_ip: number }>(
    `SELECT
       count(*) FILTER (WHERE actor_email = $1) AS by_email,
       count(*) FILTER (WHERE $2::text IS NOT NULL AND ip = $2) AS by_ip
     FROM app.audit_logs
     WHERE action = 'login' AND result = 'rejected'
       AND created_at > now() - make_interval(mins => $3)
       AND (actor_email = $1 OR ($2::text IS NOT NULL AND ip = $2))`,
    [email, ip ?? null, LOGIN_WINDOW_MINUTES],
  );
  const r = rows[0];
  return r.by_email >= MAX_FAILED_LOGINS_PER_EMAIL || r.by_ip >= MAX_FAILED_LOGINS_PER_IP;
}

export const NOT_REGISTERED =
  "Todavía no creaste tu cuenta con ese mail. Primero tenés que crear tu cuenta con el mail que le diste a Juli: ponés tu mail, elegís una contraseña y entrás.";

export async function authenticate(input: { email: unknown; password: unknown; ip?: string | null }): Promise<Actor> {
  const parsed = parseEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  if (!parsed.ok || !password) {
    throw new AppError("VALIDATION", "Ingresá tu email y tu contraseña.");
  }
  const email = parsed.normalized;
  if (await tooManyFailures(email, input.ip)) {
    await auditSafe({ actorEmail: email, action: "login", result: "rejected", ip: input.ip, details: { reason: "rate_limited" } });
    throw new AppError("RATE_LIMITED", "Demasiados intentos fallidos. Esperá 15 minutos e intentá de nuevo.");
  }
  const { rows } = await getDb().query<UserRow>("SELECT * FROM app.users WHERE email = $1", [email]);
  const user = rows[0];
  dummyHash ??= hashPassword("dummy-password-for-timing");
  const ok = user?.password_hash
    ? await verifyPassword(user.password_hash, password)
    : (await verifyPassword(await dummyHash, password), false);

  if (!user || !ok || user.status !== "active") {
    await auditSafe({
      actorId: user?.id ?? null,
      actorEmail: email,
      action: "login",
      result: "rejected",
      ip: input.ip,
      details: { reason: !user ? "unknown_email" : !ok ? "bad_password" : `status_${user.status}` },
    });
    if (user && ok && user.status === "disabled") {
      throw new AppError("FORBIDDEN", "Esta cuenta está deshabilitada. Contactá al administrador.");
    }
    // Nunca creó su cuenta (no eligió contraseña) o el mail no tiene cuenta: primero tiene que crearla.
    if (!user || (!user.password_hash && user.status === "pending")) throw new AppError("NOT_FOUND", NOT_REGISTERED);
    throw new AppError("VALIDATION", "La contraseña no es correcta. Si no te la acordás, tocá “Olvidé mi contraseña”.");
  }

  let actor = toActor(user);
  if (!user.is_admin && bootstrapAdminEmails().has(email)) {
    await getDb().query("UPDATE app.users SET is_admin = true, updated_at = now() WHERE id = $1", [user.id]);
    actor = { ...actor, isAdmin: true };
  }
  await auditSafe({ actorId: user.id, actorEmail: email, action: "login", result: "success", ip: input.ip });
  return actor;
}

// ---------------------------------------------------------------------------
// Sesiones persistentes (token aleatorio en cookie httpOnly; en la base solo el hash)
// ---------------------------------------------------------------------------
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000);
  await getDb().query(
    "INSERT INTO app.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [sha256(token), userId, expiresAt],
  );
  // Limpieza oportunista de sesiones vencidas.
  await getDb().query("DELETE FROM app.sessions WHERE expires_at < now() - interval '1 day'");
  return { token, expiresAt };
}

export async function validateSessionToken(token: string | undefined | null): Promise<Actor | null> {
  if (!token || token.length > 200) return null;
  const hash = sha256(token);
  const { rows } = await getDb().query<UserRow & { session_expires_at: Date }>(
    `SELECT u.*, s.expires_at AS session_expires_at FROM app.sessions s
       JOIN app.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  // Renovación: si pasó más de un día desde la última, vuelve a durar SESSION_TTL_DAYS (una escritura por día como máximo).
  if (row.session_expires_at.getTime() < Date.now() + (SESSION_TTL_DAYS - 1) * 24 * 3600 * 1000) {
    await getDb()
      .query("UPDATE app.sessions SET expires_at = now() + make_interval(days => $2) WHERE token_hash = $1", [hash, SESSION_TTL_DAYS])
      .catch((err) => console.error("[session] no se pudo renovar:", (err as Error).message));
  }
  return toActor(row);
}

export async function revokeSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await getDb().query("DELETE FROM app.sessions WHERE token_hash = $1", [sha256(token)]);
}

export async function revokeAllSessions(userId: string, db: Queryable = getDb()): Promise<void> {
  await db.query("DELETE FROM app.sessions WHERE user_id = $1", [userId]);
}

// ---------------------------------------------------------------------------
// Recuperación de acceso
// ---------------------------------------------------------------------------
export async function createPasswordResetToken(
  userId: string,
  createdBy: string | null,
  db: Queryable = getDb(),
): Promise<string> {
  const token = newToken();
  // Un solo enlace vigente por usuario.
  await db.query(
    "UPDATE app.password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
    [userId],
  );
  await db.query(
    `INSERT INTO app.password_reset_tokens (token_hash, user_id, created_by, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [sha256(token), userId, createdBy, RESET_TTL_MINUTES],
  );
  return token;
}

/**
 * Solicitud de recuperación iniciada por el propio usuario.
 * Siempre responde igual (no revela si el email existe).
 */
export type ResetRequestResult = "sent" | "disabled" | "failed";

/**
 * Pedido de "olvidé mi contraseña". Si el envío de mails está configurado, le manda al
 * egresado un enlace personal (vale 24 h, un solo uso). Si no, el administrador genera
 * el enlace a mano desde el panel.
 */
export async function requestPasswordReset(input: { email: unknown; baseUrl: string; ip?: string | null }): Promise<ResetRequestResult> {
  const parsed = parseEmail(input.email);
  if (!parsed.ok) throw new AppError("VALIDATION", parsed.reason);
  const email = parsed.normalized;

  const recent = await getDb().query<{ n: number }>(
    `SELECT count(*) AS n FROM app.audit_logs
      WHERE action = 'password_reset_request' AND (actor_email = $1 OR ($2::text IS NOT NULL AND ip = $2))
        AND created_at > now() - interval '1 hour'`,
    [email, input.ip ?? null],
  );
  if (recent.rows[0].n >= 5) {
    throw new AppError("RATE_LIMITED", "Ya pediste varios enlaces. Esperá una hora o pedile ayuda al administrador.");
  }

  const { rows } = await getDb().query<UserRow>("SELECT * FROM app.users WHERE email = $1", [email]);
  const user = rows[0];
  if (!user || (!user.password_hash && user.status === "pending")) {
    await auditSafe({ actorId: user?.id ?? null, actorEmail: email, action: "password_reset_request", result: "rejected", ip: input.ip, details: { reason: user ? "not_registered" : "unknown_email" } });
    throw new AppError("NOT_FOUND", NOT_REGISTERED);
  }
  if (user.status === "disabled") {
    throw new AppError("FORBIDDEN", "Esta cuenta está deshabilitada. Contactá al administrador.");
  }
  let result: ResetRequestResult = "disabled";
  if (emailEnabled()) {
    const token = await createPasswordResetToken(user.id, null);
    const link = `${input.baseUrl}/restablecer?token=${encodeURIComponent(token)}`;
    try {
      // Se manda a la dirección tal como la escribió (es la misma casilla que la de su cuenta).
      await sendEmail({
        to: parsed.original,
        subject: "Nueva contraseña – Invitaciones Fiesta de Egresados",
        text: `Hola${user.display_name ? ` ${user.display_name}` : ""}:\n\nPara crear una nueva contraseña entrá a este enlace (vale 24 horas y se puede usar una sola vez):\n\n${link}\n\nDespués entrás directo a tu panel.\n\nSi no lo pediste vos, ignorá este mensaje: tu contraseña no cambia.`,
      });
      result = "sent";
    } catch (err) {
      result = "failed";
      console.error("[auth] fallo el envío del email de recuperación:", (err as Error).message);
    }
  }
  await auditSafe({
    actorId: user.id,
    actorEmail: email,
    action: "password_reset_request",
    result: result === "failed" ? "error" : "success",
    ip: input.ip,
    details: { emailSent: result === "sent", result },
  });
  return result;
}

export async function resetPassword(input: {
  token: unknown;
  password: unknown;
  passwordConfirm: unknown;
  ip?: string | null;
}): Promise<Actor> {
  const token = typeof input.token === "string" ? input.token : "";
  const password = validatePassword(input.password);
  if (input.password !== input.passwordConfirm) {
    throw new AppError("VALIDATION", "Las contraseñas no coinciden.");
  }
  const passwordHash = await hashPassword(password);
  return withTransaction(async (c) => {
    const { rows } = await c.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM app.password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [sha256(token)],
    );
    const t = rows[0];
    if (!t) throw new AppError("VALIDATION", "El enlace no es válido o ya venció. Pedí uno nuevo.");
    const u = await c.query<UserRow>("SELECT * FROM app.users WHERE id = $1 FOR UPDATE", [t.user_id]);
    const user = u.rows[0];
    if (!user || user.status === "disabled") {
      throw new AppError("FORBIDDEN", "Esta cuenta está deshabilitada. Contactá al administrador.");
    }
    await c.query("UPDATE app.password_reset_tokens SET used_at = now() WHERE id = $1", [t.id]);
    const upd = await c.query<UserRow>(
      `UPDATE app.users
          SET password_hash = $2,
              status = 'active',
              registered_at = COALESCE(registered_at, now()),
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [user.id, passwordHash],
    );
    await revokeAllSessions(user.id, c);
    await audit({ actorId: user.id, actorEmail: user.email, action: "password_reset", result: "success", ip: input.ip }, c);
    return toActor(upd.rows[0]);
  });
}

export async function setRegistrationCode(code: string | null, db: Queryable = getDb()): Promise<void> {
  const value = code && code.trim() ? sha256(code.trim().toLowerCase()) : null;
  await db.query(
    `INSERT INTO app.settings (key, value, updated_at) VALUES ('registration_code_hash', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [value],
  );
}
