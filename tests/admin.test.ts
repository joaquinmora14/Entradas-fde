import { describe, expect, it } from "vitest";
import {
  cancelInvitation,
  cancelInvitationGroup,
  correctInvitationEmail,
  deletePendingUser,
  generateAccessLink,
  getAdminOverview,
  importGraduates,
  listAuditLogs,
  listInvitesByGraduate,
  listInvitations,
  listUsers,
  setUserDisabled,
  updateRegistrationCode,
} from "@/server/admin";
import { importPool, listPool, updatePoolPerson } from "@/server/pool-admin";
import { diagnoseSheet, reconcileSheet } from "@/server/sheets/sync";
import { createSession, validateSessionToken } from "@/server/auth";
import { inviteFromPool, inviteGroup, inviteGuest } from "@/server/invitations";
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
      () => listInvitesByGraduate(juan),
      () => cancelInvitationGroup(juan, "00000000-0000-4000-8000-000000000000", "x"),
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

  it("la lista de egresados y el panel público están en orden alfabético (con tildes bien ordenadas)", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false, name: "Org" });
    await importGraduates(admin, "z@example.com,Zoe Ruiz\nb@example.com,Bruno Paz\na@example.com,Álvaro Díaz\nm@example.com,martín López\nc@example.com,Ana Gómez");
    const names = (await listUsers(admin)).filter((u) => u.isGraduate).map((u) => u.displayName);
    expect(names).toEqual(["Álvaro Díaz", "Ana Gómez", "Bruno Paz", "martín López", "Zoe Ruiz"]);
    const { getPublicBoard } = await import("@/server/public");
    expect((await getPublicBoard()).graduates.map((g) => g.name)).toEqual(names);
  });

  it("quién invitó a quién: cada egresado con sus invitados agrupados", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const zoe = await makeUser({ email: "zoe@example.com", name: "Zoe" });
    const ana = await makeUser({ email: "ana@example.com", name: "Ana" });
    await makeUser({ email: "beto@example.com", name: "Beto" });
    await inviteGroup(zoe, { emails: ["z1@example.com", "z2@example.com"], idempotencyKey: key() }, { syncNow: false });
    await inviteGroup(zoe, { emails: ["z3@example.com"], idempotencyKey: key() }, { syncNow: false });
    await importPool(admin, "p1@example.com p2@example.com");
    const { rows } = await (await import("@/server/db")).getDb().query("SELECT group_id FROM app.pool_people LIMIT 1");
    await inviteFromPool(ana, { poolGroupId: rows[0].group_id, idempotencyKey: key() }, { syncNow: false });
    // Una anulada no aparece.
    const r = await inviteGuest(ana, { email: "anulada@example.com", idempotencyKey: key() }, { syncNow: false });
    if (r.kind === "created") await cancelInvitation(admin, r.invitationId, "error", { syncNow: false });

    const list = await listInvitesByGraduate(admin);
    expect(list.map((g) => [g.name, g.used, g.groups.map((gr) => [gr.source, gr.emails])])).toEqual([
      ["Ana", 2, [["pool", ["p1@example.com", "p2@example.com"]]]],
      ["Beto", 0, []],
      ["Zoe", 3, [["direct", ["z3@example.com"]], ["direct", ["z1@example.com", "z2@example.com"]]]],
    ]);
  });

  it("el admin borra un grupo entero o un solo mail: las entradas vuelven al egresado y salen de la planilla", async () => {
    const { MemorySheetsClient } = await import("@/server/sheets/memory");
    const { setSheetsClientForTests } = await import("@/server/sheets/sync");
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const g = await inviteGroup(juan, { emails: ["a@example.com", "b@example.com", "c@example.com"], idempotencyKey: key() });
    await inviteGroup(juan, { emails: ["d@example.com", "e@example.com"], idempotencyKey: key() });
    if (g.kind !== "created") throw new Error("no creado");
    expect(sheet.rows.map((r) => r[0])).toEqual(["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"]);
    expect(await quota(juan.id)).toBe(5);

    // Borrar el grupo entero (3 mails).
    expect(await cancelInvitationGroup(admin, g.groupId, "Se arrepintió")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(await quota(juan.id)).toBe(2);
    expect(sheet.rows.map((r) => r[0])).toEqual(["d@example.com", "e@example.com"]);
    await expect(cancelInvitationGroup(admin, g.groupId, "otra vez")).rejects.toMatchObject({ code: "CONFLICT" });

    // Borrar un solo mail del otro grupo.
    const [grupo2] = (await listInvitesByGraduate(admin)).find((x) => x.name === "Juan")!.groups;
    await cancelInvitation(admin, grupo2.invitationIds[0], "Se arrepintió");
    expect(await quota(juan.id)).toBe(1);
    expect(sheet.rows.map((r) => r[0])).toEqual(["e@example.com"]);
    // El mail borrado se puede volver a anotar (por él o por otro).
    expect((await inviteGroup(juan, { emails: ["a@example.com"], idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
    expect(await count("SELECT count(*) AS n FROM app.audit_logs WHERE action = 'invitation_cancel'")).toBe(4);
  });
});

async function quota(userId: string): Promise<number> {
  const { rows } = await (await import("@/server/db")).getDb().query("SELECT used FROM app.invitation_quotas WHERE user_id = $1", [userId]);
  return rows[0].used;
}
