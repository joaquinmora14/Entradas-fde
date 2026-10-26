import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { inviteGuest, getDashboard } from "@/server/invitations";
import { count, key, makeUser, quotaOf } from "./support/factory";

describe("Invitaciones con cupo individual", () => {
  it("pruebas 3 y 4: registra la invitación en PostgreSQL y descuenta exactamente una entrada", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const r = await inviteGuest(juan, { email: "Persona@Example.com", idempotencyKey: key() });
    expect(r).toMatchObject({ kind: "created", remaining: 15, sync: "pending" });
    const { rows } = await getDb().query("SELECT * FROM app.invitations");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guest_email_normalized: "persona@example.com",
      inviter_id: juan.id,
      source: "direct",
      status: "active",
    });
    expect(await quotaOf(juan.id)).toEqual({ used: 1, initial_quota: 16 });
    // la tarea de sincronización quedó registrada de forma durable en la misma transacción
    expect(await count("SELECT count(*) AS n FROM app.sheet_sync_jobs WHERE status = 'pending'")).toBe(1);
  });

  it("prueba 5: rechaza un email ya invitado por otro egresado (aunque cambie mayúsculas o variantes de Gmail)", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    const maria = await makeUser({ email: "maria@example.com" });
    expect((await inviteGuest(juan, { email: "ana.lopez@gmail.com", idempotencyKey: key() })).kind).toBe("created");
    const r = await inviteGuest(maria, { email: "  AnaLopez+fiesta@GMAIL.com ", idempotencyKey: key() });
    expect(r.kind).toBe("duplicate");
    expect(await quotaOf(maria.id)).toEqual({ used: 0, initial_quota: 16 });
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(1);
  });

  it("prueba 6: dos solicitudes simultáneas con el mismo email generan como máximo una invitación", async () => {
    const users = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makeUser({ email: `egresado${i}@example.com` })),
    );
    const results = await Promise.all(
      users.map((u) => inviteGuest(u, { email: "carrera@example.com", idempotencyKey: key() }, { syncNow: false })),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "duplicate")).toHaveLength(7);
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(1);
    expect(await count("SELECT COALESCE(sum(used), 0) AS n FROM app.invitation_quotas")).toBe(1);
  });

  it("prueba 7: un egresado sin entradas disponibles no puede invitar más", async () => {
    const u = await makeUser({ email: "lleno@example.com", quota: 2 });
    expect((await inviteGuest(u, { email: "a1@example.com", idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
    expect((await inviteGuest(u, { email: "a2@example.com", idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
    const r = await inviteGuest(u, { email: "a3@example.com", idempotencyKey: key() }, { syncNow: false });
    expect(r.kind).toBe("quota_exhausted");
    expect(await quotaOf(u.id)).toEqual({ used: 2, initial_quota: 2 });
  });

  it("prueba 7 bis: muchas solicitudes simultáneas del mismo egresado nunca superan su cupo", async () => {
    const u = await makeUser({ email: "rafaga@example.com", quota: 16 });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        inviteGuest(u, { email: `rafaga${i}@example.com`, idempotencyKey: key() }, { syncNow: false }),
      ),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(16);
    expect(results.filter((r) => r.kind === "quota_exhausted")).toHaveLength(9);
    expect(await quotaOf(u.id)).toEqual({ used: 16, initial_quota: 16 });
    expect(await count("SELECT count(*) AS n FROM app.invitations WHERE inviter_id = $1", [u.id])).toBe(16);
  });

  it("prueba 9: los errores no producen descuentos sin invitación válida", async () => {
    const u = await makeUser({ email: "errores@example.com" });
    expect((await inviteGuest(u, { email: "no-es-un-email", idempotencyKey: key() })).kind).toBe("validation");
    expect((await inviteGuest(u, { email: "ok@example.com", idempotencyKey: "no-uuid" })).kind).toBe("validation");
    expect((await inviteGuest(u, { email: "errores@example.com", idempotencyKey: key() })).kind).toBe("validation");
    // Falla de base de datos en medio de la transacción: se revierte todo.
    await getDb().query(`
      CREATE OR REPLACE FUNCTION app.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falla simulada'; END $$;
      CREATE TRIGGER test_fail AFTER INSERT ON app.invitations FOR EACH ROW EXECUTE FUNCTION app.test_fail();
    `);
    try {
      const r = await inviteGuest(u, { email: "fallara@example.com", idempotencyKey: key() });
      expect(r.kind).toBe("error");
    } finally {
      await getDb().query("DROP TRIGGER test_fail ON app.invitations; DROP FUNCTION app.test_fail();");
    }
    expect(await quotaOf(u.id)).toEqual({ used: 0, initial_quota: 16 });
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
    expect(await count("SELECT count(*) AS n FROM app.sheet_sync_jobs")).toBe(0);
  });

  it("idempotencia: reintentar la misma operación no crea otra invitación ni descuenta otra entrada", async () => {
    const u = await makeUser({ email: "reintento@example.com" });
    const k = key();
    const [a, b] = await Promise.all([
      inviteGuest(u, { email: "invitado@example.com", idempotencyKey: k }, { syncNow: false }),
      inviteGuest(u, { email: "invitado@example.com", idempotencyKey: k }, { syncNow: false }),
    ]);
    const c = await inviteGuest(u, { email: "invitado@example.com", idempotencyKey: k }, { syncNow: false });
    expect(a.kind).toBe("created");
    expect(b).toMatchObject({ kind: "created" });
    expect(c).toMatchObject({ kind: "created" });
    if (a.kind === "created" && c.kind === "created") expect(c.invitationId).toBe(a.invitationId);
    expect(await quotaOf(u.id)).toEqual({ used: 1, initial_quota: 16 });
  });

  it("prueba 10: un usuario no puede modificar el cupo de otro egresado", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    const maria = await makeUser({ email: "maria@example.com" });
    // Toda operación toma al egresado de la sesión: no existe parámetro para elegir otro usuario.
    await inviteGuest(juan, { email: "x@example.com", idempotencyKey: key() }, { syncNow: false });
    expect(await quotaOf(juan.id)).toEqual({ used: 1, initial_quota: 16 });
    expect(await quotaOf(maria.id)).toEqual({ used: 0, initial_quota: 16 });
    // Ni siquiera reusando la clave de idempotencia de otro usuario se afecta su cupo.
    const k = key();
    await inviteGuest(juan, { email: "y@example.com", idempotencyKey: k }, { syncNow: false });
    await inviteGuest(maria, { email: "z@example.com", idempotencyKey: k }, { syncNow: false });
    expect(await quotaOf(juan.id)).toEqual({ used: 2, initial_quota: 16 });
    expect(await quotaOf(maria.id)).toEqual({ used: 1, initial_quota: 16 });
    // La base de datos impide cupos incoherentes aunque alguien escriba directo.
    await expect(
      getDb().query("UPDATE app.invitation_quotas SET used = 17 WHERE user_id = $1", [maria.id]),
    ).rejects.toThrow();
    await expect(getDb().query("DELETE FROM app.invitations")).rejects.toThrow(/INVITATION_DELETE_FORBIDDEN/);
  });

  it("un administrador que no es egresado no tiene cupo para invitar", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    expect((await inviteGuest(admin, { email: "a@example.com", idempotencyKey: key() })).kind).toBe("validation");
  });

  it("el panel muestra el cupo y las invitaciones propias", async () => {
    const u = await makeUser({ email: "panel@example.com" });
    await inviteGuest(u, { email: "uno@example.com", idempotencyKey: key() }, { syncNow: false });
    const d = await getDashboard(u);
    expect(d.quota).toEqual({ initial: 16, used: 1, remaining: 15 });
    expect(d.invitations.map((i) => i.email)).toEqual(["uno@example.com"]);
  });
});
