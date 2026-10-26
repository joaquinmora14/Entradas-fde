import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";
import { inviteGuest } from "@/server/invitations";
import { cancelInvitation, correctInvitationEmail } from "@/server/admin";
import { MemorySheetsClient } from "@/server/sheets/memory";
import {
  diagnoseSheet,
  makeAllPendingDue,
  planSheetChanges,
  reconcileSheet,
  runSheetSync,
  setSheetsClientForTests,
} from "@/server/sheets/sync";
import { closeDb } from "@/server/db";
import { count, key, makeUser } from "./support/factory";

async function pendingJobs() {
  return count("SELECT count(*) AS n FROM app.sheet_sync_jobs WHERE status = 'pending'");
}

describe("Sincronización con Google Sheets (hoja simulada en memoria)", () => {
  it("prueba 12: una invitación válida se exporta automáticamente con email y egresado", async () => {
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    const r1 = await inviteGuest(juan, { email: "persona1@example.com", idempotencyKey: key() });
    const r2 = await inviteGuest(maria, { email: "persona2@example.com", idempotencyKey: key() });
    expect(r1).toMatchObject({ kind: "created", sync: "synced" });
    expect(r2).toMatchObject({ kind: "created", sync: "synced" });
    expect(sheet.header).toEqual(["Invitado", "Invitado por"]);
    expect(sheet.rows).toEqual([
      ["persona1@example.com", "Juan"],
      ["persona2@example.com", "María"],
    ]);
    expect(await pendingJobs()).toBe(0);
  });

  it("prueba 13: si Google Sheets se cae, la invitación se conserva y se sincroniza al recuperarse", async () => {
    const sheet = new MemorySheetsClient();
    sheet.down = true;
    setSheetsClientForTests(sheet);
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const r = await inviteGuest(juan, { email: "caida@example.com", idempotencyKey: key() });
    expect(r).toMatchObject({ kind: "created", sync: "pending" });
    expect(await count("SELECT count(*) AS n FROM app.invitations WHERE status = 'active'")).toBe(1);
    const { rows } = await getDb().query("SELECT attempts, last_error, next_attempt_at > now() AS backoff FROM app.sheet_sync_jobs");
    expect(rows[0]).toMatchObject({ attempts: 1, backoff: true });
    expect(rows[0].last_error).toContain("no disponible");

    // Antes de que venza la espera progresiva no se reintenta.
    expect((await runSheetSync({ trigger: "cron" })).status).toBe("idle");

    sheet.down = false;
    await makeAllPendingDue();
    const res = await runSheetSync({ trigger: "cron" });
    expect(res).toMatchObject({ status: "ok", appended: 1 });
    expect(sheet.rows).toEqual([["caida@example.com", "Juan"]]);
    const inv = await getDb().query("SELECT sync_status FROM app.invitations");
    expect(inv.rows[0].sync_status).toBe("synced");
  });

  it("prueba 14: un reinicio del servidor no elimina las tareas pendientes", async () => {
    setSheetsClientForTests(null); // sin Google configurado: quedan en el outbox
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    await inviteGuest(juan, { email: "reinicio@example.com", idempotencyKey: key() });
    expect(await pendingJobs()).toBe(1);

    // "Reinicio": se descartan todas las conexiones y el estado en memoria del proceso.
    await closeDb();
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    expect(await pendingJobs()).toBe(1);
    const res = await runSheetSync({ trigger: "cron" });
    expect(res.status).toBe("ok");
    expect(sheet.rows).toEqual([["reinicio@example.com", "Juan"]]);
    expect(await pendingJobs()).toBe(0);
  });

  it("prueba 15: los reintentos no duplican filas aunque la escritura anterior sí haya llegado", async () => {
    const sheet = new MemorySheetsClient();
    sheet.failAfterWriteOnce = "appendRows"; // Google escribe pero la respuesta se pierde
    setSheetsClientForTests(sheet);
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const r = await inviteGuest(juan, { email: "timeout@example.com", idempotencyKey: key() });
    expect(r).toMatchObject({ kind: "created", sync: "pending" });
    expect(sheet.rows).toHaveLength(1);

    for (let i = 0; i < 3; i++) {
      await makeAllPendingDue();
      await runSheetSync({ trigger: "cron" });
    }
    expect(sheet.rows).toEqual([["timeout@example.com", "Juan"]]);
    expect(await pendingJobs()).toBe(0);

    // Ejecuciones concurrentes del sincronizador tampoco duplican (lease).
    await inviteGuest(juan, { email: "otro@example.com", idempotencyKey: key() }, { syncNow: false });
    await Promise.all([
      runSheetSync({ trigger: "a", waitForLeaseMs: 2000 }),
      runSheetSync({ trigger: "b", waitForLeaseMs: 2000 }),
      runSheetSync({ trigger: "c", waitForLeaseMs: 2000 }),
    ]);
    expect(sheet.rows.filter((x) => x[0] === "otro@example.com")).toHaveLength(1);
  });

  it("prueba 17: la reconciliación no elimina ni duplica invitaciones válidas", async () => {
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    await inviteGuest(juan, { email: "a@example.com", idempotencyKey: key() });
    await inviteGuest(maria, { email: "b@example.com", idempotencyKey: key() });
    await inviteGuest(juan, { email: "c@example.com", idempotencyKey: key() });
    // Alguien tocó la hoja a mano: borró una fila, duplicó otra, cambió un nombre y agregó un email inexistente.
    sheet.rows = [
      ["a@example.com", "Juan"],
      ["A@Example.com ", "Juan"],
      ["b@example.com", "Otro nombre"],
      ["fantasma@example.com", "Nadie"],
      ["", ""],
    ];
    const diag = await diagnoseSheet();
    expect(diag.missingInSheet).toEqual(["c@example.com"]);
    expect(diag.duplicates).toHaveLength(1);
    expect(diag.wrongInviter).toHaveLength(1);
    expect(diag.extraInSheet.map((e) => e.guest)).toEqual(["fantasma@example.com"]);

    const res = await reconcileSheet("test");
    expect(res.status).toBe("ok");
    const emails = sheet.rows.filter((r) => r[0]).map((r) => r[0].trim().toLowerCase()).sort();
    expect(emails).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(sheet.rows.find((r) => r[0] === "b@example.com")?.[1]).toBe("María");
    // La base de datos no cambió.
    expect(await count("SELECT count(*) AS n FROM app.invitations WHERE status = 'active'")).toBe(3);
    // Reconciliar de nuevo no cambia nada.
    const again = await reconcileSheet("test");
    expect(again).toMatchObject({ appended: 0, removed: 0, updated: 0 });
  });

  it("anular y corregir invitaciones actualiza la hoja y el cupo de forma consistente", async () => {
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const r = await inviteGuest(juan, { email: "tipeo@exmaple.com", idempotencyKey: key() });
    if (r.kind !== "created") throw new Error("no creada");
    const newId = await correctInvitationEmail(admin, r.invitationId, "tipeo@example.com");
    expect(sheet.rows).toEqual([["tipeo@example.com", "Juan"]]);
    expect(await count("SELECT used AS n FROM app.invitation_quotas WHERE user_id = $1", [juan.id])).toBe(1);
    await cancelInvitation(admin, newId, "Ya no viene");
    expect(sheet.rows).toEqual([]);
    expect(await count("SELECT used AS n FROM app.invitation_quotas WHERE user_id = $1", [juan.id])).toBe(0);
    // Tras anular, el email puede volver a invitarse.
    expect((await inviteGuest(juan, { email: "tipeo@example.com", idempotencyKey: key() })).kind).toBe("created");
    expect(sheet.rows).toEqual([["tipeo@example.com", "Juan"]]);
  });

  it("el plan incremental nunca agrega un email que ya está en la hoja", () => {
    const desired = new Map([["x@example.com", { guest: "x@example.com", invitedBy: "Juan" }]]);
    const plan = planSheetChanges(
      [{ rowNumber: 2, guest: "X@example.com", invitedBy: "Juan" }],
      desired,
      new Set(["x@example.com"]),
    );
    expect(plan).toEqual({ appends: [], updates: [], deletes: [] });
  });
});
