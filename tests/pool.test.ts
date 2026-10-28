import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { inviteFromPool, inviteGuest, getDashboard } from "@/server/invitations";
import { checkPoolEmails, getPoolBoard, importPool, listPool, removeOwnPoolPerson, updatePoolPerson } from "@/server/pool-admin";
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
    // "no-es-email" no tiene @: se ignora como cualquier línea sin mail (nombre, DNI…).
    expect(report.invalid).toHaveLength(0);
    expect(report.ignoredLines).toBe(2);
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
    // Las líneas sin mail (encabezado, "Sin mail") se ignoran: no son errores.
    expect(report.invalid).toHaveLength(0);
    expect(report.ignoredLines).toBe(2);
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

  it("cualquier egresado puede sumar gente al pool pegando una lista y ver la lista", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    await inviteGuest(maria, { email: "con.entrada@example.com", idempotencyKey: key() }, { syncNow: false });
    const r = await importPool(juan, "Pedro - pedro@gmail.com - 40111222\nLaura laura@hotmail.com 41000111\ncon.entrada@example.com\nmaria@example.com");
    expect(r.added).toEqual(["pedro@gmail.com", "laura@hotmail.com"]);
    expect(r.conflicts).toEqual([
      { email: "con.entrada@example.com", reason: "Ya tiene entrada" }, // al egresado no se le dice quién
      { email: "maria@example.com", reason: "Es un egresado" },
    ]);
    const board = await getPoolBoard(maria);
    expect(board.available.map((p) => [p.email, p.addedBy, p.mine])).toEqual([
      ["pedro@gmail.com", "Juan", false],
      ["laura@hotmail.com", "Juan", false],
    ]);
    // María invita a la primera (FIFO) y aparece como asignada.
    await inviteFromPool(maria, { idempotencyKey: key() }, { syncNow: false });
    const after = await getPoolBoard(juan);
    expect(after.available.map((p) => p.email)).toEqual(["laura@hotmail.com"]);
    expect(after.assigned).toMatchObject([{ email: "pedro@gmail.com", invitedBy: "María" }]);
  });

  it("un egresado solo puede quitar personas que cargó él y que nadie invitó", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    await importPool(juan, "a@example.com\nb@example.com");
    const [a, b] = (await getPoolBoard(juan)).available;
    await expect(removeOwnPoolPerson(maria, a.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await removeOwnPoolPerson(juan, a.id);
    expect((await getPoolBoard(juan)).available.map((p) => p.email)).toEqual(["b@example.com"]);
    await inviteFromPool(maria, { idempotencyKey: key() }, { syncNow: false }); // asigna b
    await expect(removeOwnPoolPerson(juan, b.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(getPoolBoard(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("con una lista tipo formulario (un dato por renglón) toma solo los mails y no marca errores", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const r = await importPool(
      juan,
      "Nombre y apellido: Lucila Viola\nDNI: 45.123.456\nMail: lucila.violaa14@gmail.com\n\nNombre y apellido: Ema Gómez\nDNI: 46.000.111\nMail: Emahg2010@Gmail.com\nRaro: maria@gmail",
    );
    expect(r.added).toEqual(["lucila.violaa14@gmail.com", "emahg2010@gmail.com"]);
    expect(r.ignoredLines).toBe(4);
    expect(r.invalid).toEqual([{ value: "maria@gmail", reason: "No es un mail válido. ¿Quisiste decir maria@gmail.com?" }]);
  });

  it("revisa una lista antes de sumarla al pool sin modificar nada", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await importPool(admin, "en.pool@example.com");
    await inviteGuest(juan, { email: "con.entrada@example.com", idempotencyKey: key() }, { syncNow: false });
    const r = await checkPoolEmails(juan, ["nuevo@example.com", "en.pool@example.com", "con.entrada@example.com", "juan@example.com", "Nuevo@Example.com", "mal"]);
    expect(r.items.map((i) => i.status)).toEqual(["ok", "in_pool", "has_entry", "graduate", "repeated", "invalid"]);
    expect(r.items[2].message).toBeUndefined(); // al egresado no se le dice quién la anotó
    const asAdmin = await checkPoolEmails(admin, ["con.entrada@example.com"]);
    expect(asAdmin.items[0].message).toBe("Anotado por Juan");
    expect(await available()).toBe(1);
  });
});
