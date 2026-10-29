import { describe, expect, it, vi } from "vitest";

// El envío por Gmail se simula: se guarda lo que se habría mandado.
const sentMails: Array<{ to: string; subject: string; text: string; from: unknown }> = [];
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: { auth: { user: string; pass: string } }) => ({
      sendMail: async (m: { to: string; subject: string; text: string; from: unknown }) => {
        if (opts.auth.pass === "fallar") throw new Error("SMTP caído");
        sentMails.push(m);
      },
    }),
  },
}));
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

  it("crear cuenta pide solo mail y contraseña; después entra con eso", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    await importGraduates(admin, "email,nombre\nnueva@example.com,Ana Nueva");
    const a = await registerAccount({ email: "Nueva@Example.com", password: "una-clave-larga" });
    expect(a).toMatchObject({ email: "nueva@example.com", displayName: "Ana Nueva", isGraduate: true });
    await expect(authenticate({ email: "nueva@example.com", password: "una-clave-larga" })).resolves.toMatchObject({ id: a.id });
    // Una segunda vez avisa que ya creó la cuenta.
    await expect(registerAccount({ email: "nueva@example.com", password: "otra-clave-larga" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Ya creaste tu cuenta"),
    });
  });

  it("si intenta ingresar sin haber creado la cuenta, le dice que la cree con el mail que le dio a Juli", async () => {
    await makeUser({ email: "pendiente@example.com", status: "pending", name: "Pendiente" });
    for (const email of ["pendiente@example.com", "Pendiente@Example.com", "no.esta@example.com"]) {
      await expect(authenticate({ email, password: "cualquier-cosa" })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: expect.stringContaining("el mail que le diste a Juli"),
      });
    }
    // Con cuenta creada y contraseña equivocada, el mensaje es otro.
    await makeUser({ email: "activa@example.com" });
    await expect(authenticate({ email: "activa@example.com", password: "equivocada" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("contraseña no es correcta"),
    });
    // Un mail que no está en la lista no puede crear cuenta, y el mensaje lo explica.
    await expect(registerAccount({ email: "no.esta@example.com", password: "una-clave-larga" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("le diste a Juli"),
    });
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
    // Sin envío de mails configurado, se le dice que le pida el link al administrador.
    await expect(requestPasswordReset({ email: "olvido@example.com", baseUrl: "http://x" })).resolves.toBe("disabled");
  });

  it("olvidé mi contraseña con Gmail configurado: le llega un link que funciona y entra directo", async () => {
    process.env.GMAIL_USER = "joaquitomora13@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
    sentMails.length = 0;
    try {
      await makeUser({ email: "juanperez@gmail.com", name: "Juan" });
      // Escribe su mail con puntos y mayúsculas: le llega a esa dirección (Gmail ignora los puntos: es la misma casilla).
      expect(await requestPasswordReset({ email: "Juan.Perez@gmail.com", baseUrl: "https://entradas-fde.vercel.app" })).toBe("sent");
      expect(sentMails).toHaveLength(1);
      expect(sentMails[0]).toMatchObject({ to: "juan.perez@gmail.com", from: { address: "joaquitomora13@gmail.com" } });
      const link = /https:\/\/entradas-fde\.vercel\.app\/restablecer\?token=(\S+)/.exec(sentMails[0].text);
      expect(link).not.toBeNull();
      const actor = await resetPassword({ token: decodeURIComponent(link![1]), password: "clave-nueva-123", passwordConfirm: "clave-nueva-123" });
      expect(actor.email).toBe("juanperez@gmail.com");
      await expect(authenticate({ email: "juan.perez@gmail.com", password: "clave-nueva-123" })).resolves.toMatchObject({ id: actor.id });

      // Nunca creó la cuenta o el mail no está: se le dice que primero la cree (no se manda nada).
      await makeUser({ email: "pendiente@example.com", status: "pending" });
      for (const email of ["pendiente@example.com", "noexiste@example.com"]) {
        await expect(requestPasswordReset({ email, baseUrl: "http://x" })).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("le diste a Juli") });
      }
      expect(sentMails).toHaveLength(1);

      // Si Gmail falla, se avisa (y no se cae la app).
      process.env.GMAIL_APP_PASSWORD = "fallar";
      expect(await requestPasswordReset({ email: "juanperez@gmail.com", baseUrl: "http://x" })).toBe("failed");
    } finally {
      delete process.env.GMAIL_USER;
      delete process.env.GMAIL_APP_PASSWORD;
    }
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
    expect(() => parseServiceAccount('{"private_key": SECRETO-123 ,')).toThrow(/largo/);
    try {
      parseServiceAccount('{"private_key": SECRETO-123 ,');
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
