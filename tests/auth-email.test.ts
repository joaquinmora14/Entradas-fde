import { describe, expect, it } from "vitest";
import {
  authenticate,
  createSession,
  registerAccount,
  requestPasswordReset,
  resetPassword,
  revokeSession,
  setRegistrationCode,
  validateSessionToken,
  createPasswordResetToken,
} from "@/server/auth";
import { parseEmail } from "@/server/email";
import { AppError } from "@/server/errors";
import { importGraduates } from "@/server/admin";
import { makeUser, PASSWORD } from "./support/factory";
import { getDb } from "@/server/db";

describe("Normalización de emails (prueba 8)", () => {
  it("quita espacios, pasa a minúsculas y unifica variantes de Gmail", () => {
    expect(parseEmail("  Persona@Example.COM ")).toMatchObject({ ok: true, normalized: "persona@example.com" });
    expect(parseEmail("Juan.Perez+fiesta@Gmail.com")).toMatchObject({ ok: true, normalized: "juanperez@gmail.com" });
    expect(parseEmail("juanperez@googlemail.com")).toMatchObject({ ok: true, normalized: "juanperez@gmail.com" });
    // En otros dominios los puntos sí importan.
    expect(parseEmail("juan.perez@hotmail.com")).toMatchObject({ ok: true, normalized: "juan.perez@hotmail.com" });
  });

  it("rechaza formatos inválidos", () => {
    for (const bad of ["", "sinarroba", "a@b", "a@@b.com", "a b@c.com", "@dominio.com", "x@dominio..com", "a@-b.com"]) {
      expect(parseEmail(bad).ok, bad).toBe(false);
    }
  });
});

describe("Registro y autenticación", () => {
  it("prueba 1: un egresado autorizado puede registrarse e iniciar sesión", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    await importGraduates(admin, "email,nombre\negresado@example.com,Juan Pérez");
    const actor = await registerAccount({
      email: "Egresado@Example.com",
      displayName: "",
      password: "una-clave-larga",
      passwordConfirm: "una-clave-larga",
    });
    expect(actor.displayName).toBe("Juan Pérez");
    const logged = await authenticate({ email: "egresado@example.com", password: "una-clave-larga" });
    expect(logged.id).toBe(actor.id);
    const { token } = await createSession(logged.id);
    expect((await validateSessionToken(token))?.id).toBe(actor.id);
    await revokeSession(token);
    expect(await validateSessionToken(token)).toBeNull();

    // la contraseña se guarda con argon2id, nunca en texto plano
    const { rows } = await getDb().query("SELECT password_hash FROM app.users WHERE id = $1", [actor.id]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it("prueba 2: una persona no autorizada no puede registrarse", async () => {
    await expect(
      registerAccount({ email: "intruso@example.com", displayName: "X", password: "una-clave-larga", passwordConfirm: "una-clave-larga" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { rows } = await getDb().query("SELECT count(*)::int AS n FROM app.users");
    expect(rows[0].n).toBe(0);
  });

  it("evita cuentas duplicadas y contraseñas incorrectas", async () => {
    await makeUser({ email: "ya@example.com" });
    await expect(
      registerAccount({ email: "ya@example.com", displayName: "Y", password: "una-clave-larga", passwordConfirm: "una-clave-larga" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(authenticate({ email: "ya@example.com", password: "incorrecta" })).rejects.toBeInstanceOf(AppError);
    await expect(authenticate({ email: "ya@example.com", password: PASSWORD })).resolves.toMatchObject({ email: "ya@example.com" });
  });

  it("bloquea por exceso de intentos fallidos", async () => {
    await makeUser({ email: "bloq@example.com" });
    for (let i = 0; i < 8; i++) {
      await expect(authenticate({ email: "bloq@example.com", password: "mal" })).rejects.toBeInstanceOf(AppError);
    }
    await expect(authenticate({ email: "bloq@example.com", password: PASSWORD })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("exige el código de registro cuando el administrador lo configuró", async () => {
    await makeUser({ email: "pend@example.com", status: "pending", name: "Pendiente" });
    await setRegistrationCode("Promo2026");
    const base = { email: "pend@example.com", displayName: "", password: "una-clave-larga", passwordConfirm: "una-clave-larga" };
    await expect(registerAccount({ ...base, registrationCode: "otro" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(registerAccount({ ...base, registrationCode: "promo2026" })).resolves.toMatchObject({ email: "pend@example.com" });
  });

  it("solo los emails de BOOTSTRAP_ADMIN_EMAILS se convierten en administradores", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAILS = "organiza@example.com";
    try {
      const a = await registerAccount({ email: "organiza@example.com", displayName: "Orga", password: "una-clave-larga", passwordConfirm: "una-clave-larga" });
      expect(a.isAdmin).toBe(true);
      expect(a.isGraduate).toBe(false);
    } finally {
      delete process.env.BOOTSTRAP_ADMIN_EMAILS;
    }
  });

  it("recuperación de acceso: enlace de un solo uso que invalida sesiones previas", async () => {
    const u = await makeUser({ email: "olvido@example.com" });
    const { token: session } = await createSession(u.id);
    const token = await createPasswordResetToken(u.id, null);
    await resetPassword({ token, password: "nueva-clave-123", passwordConfirm: "nueva-clave-123" });
    expect(await validateSessionToken(session)).toBeNull();
    await expect(authenticate({ email: "olvido@example.com", password: "nueva-clave-123" })).resolves.toBeTruthy();
    await expect(resetPassword({ token, password: "otra-clave-123", passwordConfirm: "otra-clave-123" })).rejects.toMatchObject({ code: "VALIDATION" });
    // la solicitud pública no revela si el email existe
    await expect(requestPasswordReset({ email: "noexiste@example.com", baseUrl: "http://x" })).resolves.toEqual({ emailSent: false });
  });
});

describe("Credencial de Google", () => {
  it("acepta el JSON pegado con variantes comunes y nunca expone la clave en el error", async () => {
    const { parseServiceAccount } = await import("@/server/sheets/google");
    const obj = { client_email: "x@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n" };
    const json = JSON.stringify(obj, null, 2);
    expect(parseServiceAccount(json).client_email).toBe(obj.client_email);
    expect(parseServiceAccount(`'${json}'`).client_email).toBe(obj.client_email);
    expect(parseServiceAccount(Buffer.from(json).toString("base64")).client_email).toBe(obj.client_email);
    expect(parseServiceAccount(json.replace(/\\n/g, "\n")).private_key).toContain("ABC");
    expect(() => parseServiceAccount('{"private_key": "SECRETO-123"')).toThrow(/largo/);
    try {
      parseServiceAccount('{"private_key": "SECRETO-123"');
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRETO");
    }
  });
});

describe("Credencial de Google pegada sin la llave final", () => {
  it("se completa la llave de cierre faltante", async () => {
    const { parseServiceAccount } = await import("@/server/sheets/google");
    const json = JSON.stringify({ client_email: "x@p.iam.gserviceaccount.com", private_key: "k", universe_domain: "googleapis.com" }, null, 2);
    expect(parseServiceAccount(json.slice(0, -1)).client_email).toBe("x@p.iam.gserviceaccount.com");
  });
});
