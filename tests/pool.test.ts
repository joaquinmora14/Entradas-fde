import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { checkGuestEmails, inviteFromPool, inviteGuest, inviteGroup, getDashboard } from "@/server/invitations";
import { checkPoolEmails, getPoolBoard, importPool, listPool, removeOwnPoolPerson, updatePoolPerson } from "@/server/pool-admin";
import { cancelInvitation } from "@/server/admin";
import { MemorySheetsClient } from "@/server/sheets/memory";
import { makeAllPendingDue, runSheetSync, setSheetsClientForTests } from "@/server/sheets/sync";
import { getPublicBoard } from "@/server/public";
import { count, key, makeUser, quotaOf } from "./support/factory";

/** El grupo disponible más antiguo (o un id inexistente si la lista está vacía). */
async function oldestId(): Promise<string> {
  const { rows } = await getDb().query("SELECT group_id AS id FROM app.pool_people WHERE status = 'available' ORDER BY seq LIMIT 1");
  return rows[0]?.id ?? "00000000-0000-4000-8000-000000000000";
}

/** Id de la invitación activa de un mail. */
async function invitationOf(email: string): Promise<string> {
  const { rows } = await getDb().query("SELECT id FROM app.invitations WHERE guest_email_normalized = $1 AND status = 'active'", [email]);
  return rows[0].id;
}

/** Las personas disponibles del tablero, en orden. */
const emailsOf = (board: { available: Array<{ people: Array<{ email: string }> }> }) => board.available.flatMap((g) => g.people.map((p) => p.email));

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

  it("pool 4, 5, 6 y 7: un egresado elige a una persona de la lista y se le descuenta una entrada", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await importPool(admin, "primero@example.com");
    await importPool(admin, "segundo@example.com");
    const r = await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false });
    expect(r).toMatchObject({ kind: "created", emails: ["primero@example.com"], remaining: 15 });
    const { rows } = await getDb().query(
      `SELECT p.status, p.assigned_to, i.inviter_id, i.source, i.guest_email_normalized
         FROM app.pool_people p JOIN app.invitations i ON i.id = p.invitation_id`,
    );
    expect(rows).toEqual([
      { status: "assigned", assigned_to: juan.id, inviter_id: juan.id, source: "pool", guest_email_normalized: "primero@example.com" },
    ]);
    expect(await available()).toBe(1);
    expect(await quotaOf(juan.id)).toEqual({ used: 1, initial_quota: 16 });
    const d = await getDashboard(juan);
    expect(d).toMatchObject({ quota: { remaining: 15 }, poolAvailable: 1, poolInvitedByMe: 1 });
    // También puede elegir un grupo que no es el primero.
    const { rows: [segundo] } = await getDb().query("SELECT group_id FROM app.pool_people WHERE email = 'segundo@example.com'");
    expect(await inviteFromPool(juan, { poolGroupId: segundo.group_id, idempotencyKey: key() }, { syncNow: false })).toMatchObject({
      kind: "created",
      emails: ["segundo@example.com"],
      remaining: 14,
    });
  });

  it("pool 8: si varios eligen a la misma persona a la vez, solo uno se la queda", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const users = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser({ email: `e${i}@example.com` })));
    await importPool(admin, "p1@example.com");
    await importPool(admin, "p2@example.com");
    const target = await oldestId();
    const results = await Promise.all(
      users.map((u) => inviteFromPool(u, { poolGroupId: target, idempotencyKey: key() }, { syncNow: false })),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "unavailable")).toHaveLength(5);
    expect(await count("SELECT count(*) AS n FROM app.invitations WHERE source = 'pool'")).toBe(1);
    // Solo al que se la quedó se le descontó una entrada.
    expect(await count("SELECT sum(used) AS n FROM app.invitation_quotas")).toBe(1);
  });

  it("no se puede elegir a alguien del pool sin entradas disponibles", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", quota: 1 });
    await importPool(admin, "p1@example.com");
    await importPool(admin, "p2@example.com");
    expect((await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
    expect((await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).kind).toBe("quota_exhausted");
    expect(await available()).toBe(1);
    expect(await quotaOf(juan.id)).toEqual({ used: 1, initial_quota: 1 });
  });

  it("anular una entrada dada desde la lista devuelve la entrada al egresado", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com");
    const r = await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false });
    if (r.kind !== "created") throw new Error("no creada");
    expect(await quotaOf(juan.id)).toEqual({ used: 1, initial_quota: 16 });
    await cancelInvitation(admin, await invitationOf("p1@example.com"), "error", { syncNow: false });
    expect(await quotaOf(juan.id)).toEqual({ used: 0, initial_quota: 16 });
  });

  it("pool 9: una solicitud repetida (error de red) no genera invitaciones adicionales", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com");
    await importPool(admin, "p2@example.com");
    const k = key();
    const [a, b] = await Promise.all([
      inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: k }, { syncNow: false }),
      inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: k }, { syncNow: false }),
    ]);
    const c = await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: k }, { syncNow: false });
    expect([a.kind, b.kind, c.kind]).toEqual(["created", "created", "created"]);
    if (a.kind === "created" && b.kind === "created" && c.kind === "created") {
      expect(b.emails).toEqual(a.emails);
      expect(c.groupId).toBe(a.groupId);
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
      const r = await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() });
      expect(r.kind).toBe("error");
    } finally {
      await getDb().query("DROP TRIGGER test_fail ON app.pool_people; DROP FUNCTION app.test_fail();");
    }
    expect(await available()).toBe(1);
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
    expect((await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
  });

  it("pool 11: si Google Sheets falla, la invitación queda pendiente y se recupera sola", async () => {
    const sheet = new MemorySheetsClient();
    sheet.down = true;
    setSheetsClientForTests(sheet);
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await importPool(admin, "p1@example.com");
    expect(sheet.rows).toEqual([]); // cargar al pool no crea filas
    const r = await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() });
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
    const r = await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false });
    const again = await importPool(admin, "P1@example.com");
    expect(again.added).toEqual([]);
    expect(await available()).toBe(0);
    if (r.kind !== "created") throw new Error("no creada");
    await cancelInvitation(admin, await invitationOf("p1@example.com"), "prueba", { syncNow: false });
    const pool = await listPool(admin);
    expect(pool[0]).toMatchObject({ status: "retired" });
    await expect(getDb().query("UPDATE app.pool_people SET status = 'available'")).rejects.toThrow();
    expect((await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).kind).toBe("unavailable");
  });

  it("invitar directamente a alguien del pool lo retira del pool disponible", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com" });
    await importPool(admin, "p1@example.com");
    expect((await inviteGuest(juan, { email: "p1@example.com", idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
    expect(await available()).toBe(0);
    expect((await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).kind).toBe("unavailable");
  });

  it("el administrador puede desactivar, reactivar y eliminar personas disponibles", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    await importPool(admin, "p1@example.com");
    await importPool(admin, "p2@example.com");
    const [p1, p2] = await listPool(admin);
    await updatePoolPerson(admin, p1.id, "retire");
    expect(await available()).toBe(1);
    await updatePoolPerson(admin, p1.id, "reactivate");
    expect(await available()).toBe(2);
    await updatePoolPerson(admin, p2.id, "delete");
    expect(await available()).toBe(1);
    expect(await count("SELECT count(*) AS n FROM app.audit_logs WHERE action LIKE 'pool_%'")).toBe(5); // 2 cargas + 3 cambios
  });

  it("pool 13 y prueba 11: el panel público no expone emails de invitados ni del pool", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan.secreto@example.com", name: "Juan" });
    await makeUser({ email: "sin.nombre@example.com" });
    await importPool(admin, "pool.secreto@example.com");
    await importPool(admin, "pool.otro@example.com");
    await inviteGuest(juan, { email: "invitado.secreto@example.com", idempotencyKey: key() }, { syncNow: false });
    await inviteFromPool(juan, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false });
    const board = await getPublicBoard();
    const json = JSON.stringify(board);
    expect(json).not.toMatch(/@/);
    expect(json).not.toContain(juan.id);
    expect(board.graduates.find((g) => g.name === "Juan")).toMatchObject({ used: 2, remaining: 14 }); // 1 directa + 1 de la lista
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
    // Las dos personas del mismo mensaje quedan como UN grupo.
    expect(board.available.map((g) => [g.people.map((p) => p.email), g.addedBy, g.mine])).toEqual([
      [["pedro@gmail.com", "laura@hotmail.com"], "Juan", false],
    ]);
    // María le da entrada al grupo: a los dos juntos.
    expect(await inviteFromPool(maria, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).toMatchObject({
      kind: "created",
      emails: ["pedro@gmail.com", "laura@hotmail.com"],
      remaining: 13, // ya había anotado 1
    });
    const after = await getPoolBoard(juan);
    expect(after.available).toEqual([]);
    expect(after.assigned).toMatchObject([{ emails: ["pedro@gmail.com", "laura@hotmail.com"], invitedBy: "María" }]);
  });

  it("un egresado solo puede quitar personas que cargó él y que nadie invitó", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    await importPool(juan, "a@example.com\nb@example.com");
    const [a, b] = (await getPoolBoard(juan)).available[0].people;
    await expect(removeOwnPoolPerson(maria, a.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await removeOwnPoolPerson(juan, a.id);
    expect(emailsOf(await getPoolBoard(juan))).toEqual(["b@example.com"]);
    await inviteFromPool(maria, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false }); // asigna b
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

  it("anotar con entradas personales a alguien de fuera de lista: se anota normal, sin avisos, y sale de la lista", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await importPool(admin, "Sofi sofi.lista@gmail.com 40111222\nOtra otra.lista@gmail.com");
    // La revisión previa no dice nada especial: es un mail que se puede anotar.
    const check = await checkGuestEmails(juan, ["sofi.lista@gmail.com", "nuevo@gmail.com"]);
    expect(check.items.map((i) => [i.email, i.status, i.message])).toEqual([
      ["sofi.lista@gmail.com", "ok", undefined],
      ["nuevo@gmail.com", "ok", undefined],
    ]);
    const r = await inviteGroup(juan, { emails: ["sofi.lista@gmail.com", "nuevo@gmail.com"], idempotencyKey: key() }, { syncNow: false });
    expect(r.kind).toBe("created");
    // Quedó en sus entradas (cupo: 2 usadas) con el mismo mail.
    expect(await quotaOf(juan.id)).toEqual({ used: 2, initial_quota: 16 });
    const mine = (await getDashboard(juan)).invitations.map((i) => i.email).sort();
    expect(mine).toEqual(["nuevo@gmail.com", "sofi.lista@gmail.com"]);
    // Y salió de fuera de lista; la otra persona sigue disponible.
    const board = await getPoolBoard(juan);
    expect(emailsOf(board)).toEqual(["otra.lista@gmail.com"]);
    // Nadie más puede anotarla ni elegirla.
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    expect((await inviteGuest(maria, { email: "sofi.lista@gmail.com", idempotencyKey: key() }, { syncNow: false })).kind).toBe("duplicate");
  });

  describe("grupos (la gente pide en grupo y va junta)", () => {
    it("un mensaje pegado queda como un grupo, en el orden en que vino, y los grupos van por antigüedad", async () => {
      const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
      const maria = await makeUser({ email: "maria@example.com", name: "María" });
      await importPool(juan, "Ana ana@gmail.com 40111222\nBeto beto@gmail.com\nCami cami@gmail.com");
      await importPool(maria, "solo@gmail.com");
      await importPool(juan, "dos.a@gmail.com dos.b@gmail.com");
      const board = await getPoolBoard(maria);
      expect(board.available.map((g) => [g.people.map((p) => p.email), g.addedBy, g.mine])).toEqual([
        [["ana@gmail.com", "beto@gmail.com", "cami@gmail.com"], "Juan", false],
        [["solo@gmail.com"], "María", true],
        [["dos.a@gmail.com", "dos.b@gmail.com"], "Juan", false],
      ]);
      expect(await count("SELECT count(DISTINCT group_id) AS n FROM app.pool_people")).toBe(3);
    });

    it("dar entrada a un grupo: todos juntos, con el mismo grupo en las invitaciones y en orden en la planilla", async () => {
      const sheet = new MemorySheetsClient();
      setSheetsClientForTests(sheet);
      const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
      const maria = await makeUser({ email: "maria@example.com", name: "María" });
      await importPool(juan, "zeta@gmail.com\nalfa@gmail.com\nmedio@gmail.com\nbeta@gmail.com");
      const r = await inviteFromPool(maria, { poolGroupId: await oldestId(), idempotencyKey: key() });
      expect(r).toMatchObject({ kind: "created", emails: ["zeta@gmail.com", "alfa@gmail.com", "medio@gmail.com", "beta@gmail.com"], remaining: 12 });
      expect(await quotaOf(maria.id)).toEqual({ used: 4, initial_quota: 16 });
      expect(await count("SELECT count(DISTINCT group_id) AS n FROM app.invitations")).toBe(1);
      expect(await count("SELECT count(*) AS n FROM app.pool_people p JOIN app.invitations i ON i.id = p.invitation_id AND i.group_id = p.group_id")).toBe(4);
      expect(sheet.rows).toEqual([
        ["zeta@gmail.com", "María"],
        ["alfa@gmail.com", "María"],
        ["medio@gmail.com", "María"],
        ["beta@gmail.com", "María"],
      ]);
      // En su panel aparece como un grupo.
      const d = await getDashboard(maria);
      expect(d.groups.map((g) => g.items.map((i) => i.email))).toEqual([["zeta@gmail.com", "alfa@gmail.com", "medio@gmail.com", "beta@gmail.com"]]);
      expect(d.poolInvitedByMe).toBe(4);
    });

    it("si no le alcanzan las entradas para todo el grupo, no se le da a nadie", async () => {
      const juan = await makeUser({ email: "juan@example.com" });
      const maria = await makeUser({ email: "maria@example.com", quota: 3 });
      await importPool(juan, "a@gmail.com b@gmail.com c@gmail.com d@gmail.com");
      const r = await inviteFromPool(maria, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false });
      expect(r).toEqual({ kind: "quota_exhausted", needed: 4, remaining: 3 });
      expect(await available()).toBe(4);
      expect(await quotaOf(maria.id)).toEqual({ used: 0, initial_quota: 3 });
      expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
    });

    it("si varios eligen el mismo grupo a la vez, uno se lo queda entero y a los demás no se les descuenta nada", async () => {
      const juan = await makeUser({ email: "juan@example.com" });
      const users = await Promise.all(Array.from({ length: 6 }, (_, i) => makeUser({ email: `e${i}@example.com` })));
      await importPool(juan, "g1@gmail.com g2@gmail.com g3@gmail.com");
      const target = await oldestId();
      const results = await Promise.all(users.map((u) => inviteFromPool(u, { poolGroupId: target, idempotencyKey: key() }, { syncNow: false })));
      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "unavailable")).toHaveLength(5);
      expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(3);
      expect(await count("SELECT count(DISTINCT inviter_id) AS n FROM app.invitations")).toBe(1);
      expect(await count("SELECT sum(used) AS n FROM app.invitation_quotas")).toBe(3);
    });

    it("si a alguien del grupo ya lo anotaron por otro lado, el grupo sigue con los demás", async () => {
      const juan = await makeUser({ email: "juan@example.com" });
      const maria = await makeUser({ email: "maria@example.com", name: "María" });
      await importPool(juan, "a@gmail.com b@gmail.com c@gmail.com");
      expect((await inviteGuest(juan, { email: "b@gmail.com", idempotencyKey: key() }, { syncNow: false })).kind).toBe("created");
      expect(emailsOf(await getPoolBoard(maria))).toEqual(["a@gmail.com", "c@gmail.com"]);
      const r = await inviteFromPool(maria, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false });
      expect(r).toMatchObject({ kind: "created", emails: ["a@gmail.com", "c@gmail.com"], remaining: 14 });
    });

    it("si la base falla en medio del grupo, no queda nadie asignado ni se descuenta nada", async () => {
      const juan = await makeUser({ email: "juan@example.com" });
      const maria = await makeUser({ email: "maria@example.com" });
      await importPool(juan, "a@gmail.com b@gmail.com c@gmail.com");
      // Falla al asignar a la tercera persona.
      await getDb().query(`
        CREATE OR REPLACE FUNCTION app.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.email = 'c@gmail.com' AND NEW.status = 'assigned' THEN RAISE EXCEPTION 'falla simulada'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_fail BEFORE UPDATE ON app.pool_people FOR EACH ROW EXECUTE FUNCTION app.test_fail();
      `);
      try {
        expect((await inviteFromPool(maria, { poolGroupId: await oldestId(), idempotencyKey: key() }, { syncNow: false })).kind).toBe("error");
      } finally {
        await getDb().query("DROP TRIGGER test_fail ON app.pool_people; DROP FUNCTION app.test_fail();");
      }
      expect(await available()).toBe(3);
      expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
      expect(await quotaOf(maria.id)).toEqual({ used: 0, initial_quota: 16 });
    });

    it("no se puede cargar un grupo de más de 16 personas (nadie podría dárselas todas juntas)", async () => {
      const juan = await makeUser({ email: "juan@example.com" });
      const list = Array.from({ length: 17 }, (_, i) => `persona${i}@gmail.com`).join("\n");
      await expect(importPool(juan, list)).rejects.toMatchObject({ code: "VALIDATION" });
      expect(await count("SELECT count(*) AS n FROM app.pool_people")).toBe(0);
      // Con 16 sí.
      expect((await importPool(juan, list.split("\n").slice(0, 16).join("\n"))).added).toHaveLength(16);
      // El archivo CSV del administrador deja a cada persona sola.
      const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
      const r = await importPool(admin, Array.from({ length: 20 }, (_, i) => `csv${i}@gmail.com`).join("\n"), { grouping: "each" });
      expect(r.added).toHaveLength(20);
      expect(await count("SELECT count(DISTINCT group_id) AS n FROM app.pool_people WHERE email LIKE 'csv%'")).toBe(20);
    });
  });
});
