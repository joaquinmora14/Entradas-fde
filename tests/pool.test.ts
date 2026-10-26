import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { inviteFromPool, inviteGuest, getDashboard } from "@/server/invitations";
import { importPool, listPool, updatePoolPerson } from "@/server/pool-admin";
import { cancelInvitation } from "@/server/admin";
import { MemorySheetsClient } from "@/server/sheets/memory";
import { makeAllPendingDue, runSheetSync, setSheetsClientForTests } from "@/server/sheets/sync";
import { getPublicBoard } from "@/server/public";
import { count, key, makeUser, quotaOf } from "./support/factory";

async function available() {
  return count("SELECT count(*) AS n FROM app.pool_people WHERE status = 'available'");
}

describe("Personas fuera de lista (pool común)", () => {
  it("pool 1 y 2: el administrador carga personas; duplicados e inválidos se informan", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const report = await importPool(
      admin,
      "email\nuno@example.com\nDOS@example.com\nuno@example.com\nno-es-email\n\"tres@example.com\"",
    );
    expect(report.added).toEqual(["uno@example.com", "dos@example.com", "tres@example.com"]);
    expect(report.duplicates).toHaveLength(1);
    expect(report.invalid).toHaveLength(1);
    // Una segunda importación no vuelve a agregar a nadie.
    const again = await importPool(admin, "uno@example.com\ncuatro@example.com");
    expect(again.added).toEqual(["cuatro@example.com"]);
    expect(again.duplicates[0].reason).toContain("Ya está en el pool");
    expect(await available()).toBe(4);
  });

  it("acepta listas tipo nombre / mail / DNI e informa las filas sin mail", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const report = await importPool(
      admin,
      "Nombre,Mail,DNI\nJuan Pérez,juan.p@gmail.com,40123456\nAna López,ANA@hotmail.com,41222333\nSin mail,,42000000\nPedro pedro@yahoo.com y su hermana sofi@yahoo.com",
    );
    expect(report.added).toEqual(["juan.p@gmail.com", "ana@hotmail.com", "pedro@yahoo.com", "sofi@yahoo.com"]);
    expect(report.invalid).toHaveLength(1);
  });

  it("pool 3: no se puede agregar a alguien que ya fue invitado normalmente", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await inviteGuest(juan, { email: "invitada@example.com", idempotencyKey: key() }, { syncNow: false });
    const report = await importPool(admin, "invitada@example.com");
    expect(report.added).toEqual([]);
    expect(report.conflicts).toEqual([{ email: "invitada@example.com", reason: "Ya fue invitada por Juan" }]);
    // Y la base de datos también lo impide.
    await expect(
      getDb().query("INSERT INTO app.pool_people (email, email_normalized) VALUES ('invitada@example.com', 'invitada@example.com')"),
    ).rejects.toThrow(/POOL_EMAIL_ALREADY_INVITED/);
  });

  it("pool 4, 5, 6 y 7: un egresado invita con una sola acción, sin tocar su cupo individual", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await importPool(admin, "primero@example.com");
    await importPool(admin, "segundo@example.com");
    const r = await inviteFromPool(juan, { idempotencyKey: key() }, { syncNow: false });
    expect(r).toMatchObject({ kind: "created", email: "primero@example.com", poolAvailable: 1 }); // FIFO
    const { rows } = await getDb().query(
      `SELECT p.status, p.assigned_to, i.inviter_id, i.source, i.guest_email_normalized
         FROM app.pool_people p JOIN app.invitations i ON i.id = p.invitation_id`,
    );
    expect(rows).toEqual([
      { status: "assigned", assigned_to: juan.id, inviter_id: juan.id, source: "pool", guest_email_normalized: "primero@example.com" },
    ]);
    expect(await available()).toBe(1);
    expect(await quotaOf(juan.id)).toEqual({ used: 0, initial_quota: 16 });
    const d = await getDashboard(juan);
    expect(d).toMatchObject({ quota: { remaining: 16 }, poolAvailable: 1, poolInvitedByMe: 1 });
  });

  it("pool 8: solicitudes simultáneas nunca asignan a la misma persona", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser({ email: `e${i}@example.com` })));
    await importPool(admin, "p1@example.com\np2@example.com\np3@example.com\np4@example.com");
    const results = await Promise.all(
      users.map((u) => inviteFromPool(u, { idempotencyKey: key() }, { syncNow: false })),
    );
    const created = results.filter((r) => r.kind === "created");
    expect(created).toHaveLength(4);
    expect(results.filter((r) => r.kind === "pool_empty")).toHaveLength(2);
    expect(new Set(created.map((r) => (r.kind === "created" ? r.email : ""))).size).toBe(4);
    expect(await count("SELECT count(*) AS n FROM app.invitations WHERE source = 'pool'")).toBe(4);
  });

  it("pool 9: una solicitud repetida (error de red) no genera invitaciones adicionales", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com\np2@example.com");
    const k = key();
    const [a, b] = await Promise.all([
      inviteFromPool(juan, { idempotencyKey: k }, { syncNow: false }),
      inviteFromPool(juan, { idempotencyKey: k }, { syncNow: false }),
    ]);
    const c = await inviteFromPool(juan, { idempotencyKey: k }, { syncNow: false });
    expect([a.kind, b.kind, c.kind]).toEqual(["created", "created", "created"]);
    if (a.kind === "created" && b.kind === "created" && c.kind === "created") {
      expect(b.email).toBe(a.email);
      expect(c.invitationId).toBe(a.invitationId);
    }
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(1);
    expect(await available()).toBe(1);
  });

  it("pool 10: si falla la base de datos durante la asignación, la persona sigue disponible", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com");
    await getDb().query(`
      CREATE OR REPLACE FUNCTION app.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falla simulada'; END $$;
      CREATE TRIGGER test_fail AFTER UPDATE ON app.pool_people FOR EACH ROW EXECUTE FUNCTION app.test_fail();
    `);
    try {
      const r = await inviteFromPool(juan, { idempotencyKey: key() });
      expect(r.kind).toBe("error");
    } finally {
      await getDb().query("DROP TRIGGER test_fail ON app.pool_people; DROP FUNCTION app.test_fail();");
    }
    expect(await available()).toBe(1);
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
    expect((await inviteFromPool(juan, { idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
  });

  it("pool 11: si Google Sheets falla, la invitación queda pendiente y se recupera sola", async () => {
    const sheet = new MemorySheetsClient();
    sheet.down = true;
    setSheetsClientForTests(sheet);
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await importPool(admin, "p1@example.com");
    expect(sheet.rows).toEqual([]); // cargar al pool no crea filas
    const r = await inviteFromPool(juan, { idempotencyKey: key() });
    expect(r).toMatchObject({ kind: "created", sync: "pending" });
    sheet.down = false;
    await makeAllPendingDue();
    await runSheetSync({ trigger: "cron" });
    expect(sheet.rows).toEqual([["p1@example.com", "Juan"]]);
  });

  it("pool 12: una persona asignada no reaparece por una importación posterior ni al anular su invitación", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com");
    const r = await inviteFromPool(juan, { idempotencyKey: key() }, { syncNow: false });
    const again = await importPool(admin, "P1@example.com");
    expect(again.added).toEqual([]);
    expect(await available()).toBe(0);
    if (r.kind !== "created") throw new Error("no creada");
    await cancelInvitation(admin, r.invitationId, "prueba", { syncNow: false });
    const pool = await listPool(admin);
    expect(pool[0]).toMatchObject({ status: "retired" });
    await expect(getDb().query("UPDATE app.pool_people SET status = 'available'")).rejects.toThrow();
    expect((await inviteFromPool(juan, { idempotencyKey: key() }, { syncNow: false })).kind).toBe("pool_empty");
  });

  it("invitar directamente a alguien del pool lo retira del pool disponible", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com");
    expect((await inviteGuest(juan, { email: "p1@example.com", idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
    expect(await available()).toBe(0);
    expect((await inviteFromPool(juan, { idempotencyKey: key() }, { syncNow: false })).kind).toBe("pool_empty");
  });

  it("el administrador puede desactivar, reactivar y eliminar personas disponibles", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    await importPool(admin, "p1@example.com\np2@example.com");
    const [p1, p2] = await listPool(admin);
    await updatePoolPerson(admin, p1.id, "retire");
    expect(await available()).toBe(1);
    await updatePoolPerson(admin, p1.id, "reactivate");
    expect(await available()).toBe(2);
    await updatePoolPerson(admin, p2.id, "delete");
    expect(await available()).toBe(1);
    expect(await count("SELECT count(*) AS n FROM app.audit_logs WHERE action LIKE 'pool_%'")).toBe(4);
  });

  it("pool 13 y prueba 11: el panel público no expone emails de invitados ni del pool", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan.secreto@example.com", name: "Juan" });
    await makeUser({ email: "sin.nombre@example.com" });
    await importPool(admin, "pool.secreto@example.com\npool.otro@example.com");
    await inviteGuest(juan, { email: "invitado.secreto@example.com", idempotencyKey: key() }, { syncNow: false });
    await inviteFromPool(juan, { idempotencyKey: key() }, { syncNow: false });
    const board = await getPublicBoard();
    const json = JSON.stringify(board);
    expect(json).not.toMatch(/@/);
    expect(json).not.toContain(juan.id);
    expect(board.graduates.find((g) => g.name === "Juan")).toMatchObject({ used: 1, remaining: 15 });
    expect(board.poolAvailable).toBe(1);
    expect(board.graduates).toHaveLength(2); // el admin que no es egresado no aparece
  });
});
