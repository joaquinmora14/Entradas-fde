import { describe, expect, it } from "vitest";
import {
  cancelInvitation,
  correctInvitationEmail,
  deletePendingUser,
  generateAccessLink,
  getAdminOverview,
  importGraduates,
  listAuditLogs,
  listInvitations,
  listUsers,
  setUserDisabled,
  updateRegistrationCode,
} from "@/server/admin";
import { importPool, listPool, updatePoolPerson } from "@/server/pool-admin";
import { diagnoseSheet, reconcileSheet } from "@/server/sheets/sync";
import { createSession, validateSessionToken } from "@/server/auth";
import { inviteGuest } from "@/server/invitations";
import { count, key, makeUser } from "./support/factory";

describe("Administración", () => {
  it("prueba 16: las operaciones administrativas están protegidas en el servidor", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    const ops: Array<() => Promise<unknown>> = [
      () => importGraduates(juan, "x@example.com"),
      () => listUsers(juan),
      () => listInvitations(juan),
      () => cancelInvitation(juan, "00000000-0000-4000-8000-000000000000", "x"),
      () => correctInvitationEmail(juan, "00000000-0000-4000-8000-000000000000", "a@example.com"),
      () => setUserDisabled(juan, juan.id, true),
      () => deletePendingUser(juan, juan.id),
      () => generateAccessLink(juan, juan.id, "http://x"),
      () => getAdminOverview(juan),
      () => listAuditLogs(juan),
      () => updateRegistrationCode(juan, "abcd"),
      () => listPool(juan),
      () => updatePoolPerson(juan, "00000000-0000-4000-8000-000000000000", "delete"),
    ];
    for (const op of ops) await expect(op()).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const op of [() => listUsers(null), () => importPool(null, "p@example.com")]) {
      await expect(op()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    // Las rutas de diagnóstico de la hoja no son accesibles sin configuración ni permisos (se protegen en la acción).
    await expect(diagnoseSheet()).rejects.toThrow();
    expect((await reconcileSheet("x")).status).toBe("not_configured");
  });

  it("importa la lista autorizada con 16 entradas por egresado sin inventar datos", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const r = await importGraduates(
      admin,
      "Email;Nombre\nana@example.com;Ana Gómez\nbeto@example.com;\nana@example.com;Ana\nmal-email;Pepe\nadmin@example.com;Admin Egresado",
    );
    expect(r.added).toEqual(["ana@example.com", "beto@example.com"]);
    expect(r.updated).toEqual(["admin@example.com"]);
    expect(r.duplicates).toEqual(["ana@example.com"]);
    expect(r.invalid).toHaveLength(1);
    const users = await listUsers(admin);
    const ana = users.find((u) => u.email === "ana@example.com")!;
    expect(ana).toMatchObject({ displayName: "Ana Gómez", status: "pending", initialQuota: 16, used: 0 });
    expect(users.find((u) => u.email === "beto@example.com")?.displayName).toBeNull();
    const ov = await getAdminOverview(admin);
    expect(ov).toMatchObject({ graduates: 3, ticketsAssigned: 48, ticketsUsed: 0, ticketsRemaining: 48 });
  });

  it("deshabilitar una cuenta cierra sus sesiones", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    const { token } = await createSession(juan.id);
    await setUserDisabled(admin, juan.id, true);
    expect(await validateSessionToken(token)).toBeNull();
    await setUserDisabled(admin, juan.id, false);
    expect(await count("SELECT count(*) AS n FROM app.users WHERE id = $1 AND status = 'active'", [juan.id])).toBe(1);
  });

  it("las correcciones quedan auditadas", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    const r = await inviteGuest(juan, { email: "x@example.com", idempotencyKey: key() }, { syncNow: false });
    if (r.kind !== "created") throw new Error();
    await cancelInvitation(admin, r.invitationId, "Error de carga", { syncNow: false });
    await expect(cancelInvitation(admin, r.invitationId, "otra vez", { syncNow: false })).rejects.toMatchObject({ code: "CONFLICT" });
    const logs = await listAuditLogs(admin, { action: "invitation_cancel" });
    expect(logs).toHaveLength(1);
    expect(logs[0].details).toMatchObject({ guest: "x@example.com", reason: "Error de carga" });
  });
});
