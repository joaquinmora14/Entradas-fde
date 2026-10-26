import { describe, expect, it } from "vitest";
import { extractEmails } from "@/lib/extract-emails";
import { checkGuestEmails, inviteMany } from "@/server/invitations";
import { getGraduateActor } from "@/server/admin";
import { listAuditLogs } from "@/server/admin";
import { count, key, makeUser, quotaOf } from "./support/factory";

describe("Extracción de mails desde texto libre", () => {
  it("toma solo los mails de una lista tipo nombre / mail / DNI", () => {
    const text = `Juan Pérez - JuanPerez@Gmail.com - 40.123.456
Ana López  ana.lopez@hotmail.com  DNI 41222333
Pedro, pedro_g@yahoo.com.ar, 38999111
repetido: juanperez@gmail.com
sin mail: Carla 39000111`;
    expect(extractEmails(text).map((e) => e.email)).toEqual([
      "juanperez@gmail.com",
      "ana.lopez@hotmail.com",
      "pedro_g@yahoo.com.ar",
    ]);
  });

  it("entiende 'arroba', espacios alrededor del @ y mailto:", () => {
    const text = "lucas arroba gmail punto com\nsofi @ outlook.com\nmailto:tomas@live.com.ar";
    expect(extractEmails(text).map((e) => e.email)).toEqual(["lucas@gmail.com", "sofi@outlook.com", "tomas@live.com.ar"]);
  });

  it("sugiere correcciones para dominios mal escritos", () => {
    const [a, b, c] = extractEmails("x@gmail.con y@hotmial.com z@gmail.com");
    expect(a).toEqual({ email: "x@gmail.con", suggestion: "x@gmail.com" });
    expect(b.suggestion).toBe("y@hotmail.com");
    expect(c.suggestion).toBeUndefined();
  });

  it("no devuelve nada si el texto no tiene mails", () => {
    expect(extractEmails("Juan 40123456\nAna")).toEqual([]);
  });
});

describe("Anotar varias entradas a la vez", () => {
  it("revisa la lista antes de anotar sin modificar nada", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    await inviteMany(maria, { items: [{ email: "tomada@example.com", idempotencyKey: key() }] }, { syncNow: false });
    await inviteMany(juan, { items: [{ email: "mia@example.com", idempotencyKey: key() }] }, { syncNow: false });
    const r = await checkGuestEmails(juan, [
      "nueva@example.com",
      "tomada@example.com",
      "mia@example.com",
      "Nueva@Example.com",
      "maria@example.com",
      "juan@example.com",
      "no-es-mail",
    ]);
    expect(r.items.map((i) => i.status)).toEqual(["ok", "taken", "mine", "repeated", "graduate", "self", "invalid"]);
    expect(r.items[1].message).toBeUndefined(); // al egresado no se le dice quién lo anotó
    expect(r.remaining).toBe(15);
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const asAdmin = await checkGuestEmails(await getGraduateActor(admin, juan.id), ["tomada@example.com"], { revealInviter: true });
    expect(asAdmin.items[0].message).toBe("Anotado por María");
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(2);
  });

  it("anota cada mail de forma independiente y reintentar el lote no duplica", async () => {
    const juan = await makeUser({ email: "juan@example.com", quota: 3 });
    const items = ["a@example.com", "b@example.com", "c@example.com", "d@example.com"].map((email) => ({ email, idempotencyKey: key() }));
    const first = await inviteMany(juan, { items }, { syncNow: false });
    expect(first.results.map((r) => r.outcome.kind)).toEqual(["created", "created", "created", "quota_exhausted"]);
    expect(first.remaining).toBe(0);
    // Reintento idéntico (p. ej. se cortó la conexión): mismo resultado, nada nuevo.
    const again = await inviteMany(juan, { items }, { syncNow: false });
    expect(again.results.map((r) => r.outcome.kind)).toEqual(["created", "created", "created", "quota_exhausted"]);
    expect(await quotaOf(juan.id)).toEqual({ used: 3, initial_quota: 3 });
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(3);
  });

  it("el administrador puede anotar en nombre de un egresado usando su cupo y queda auditado", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan", status: "pending" });
    const grad = await getGraduateActor(admin, juan.id);
    const r = await inviteMany(grad, { items: [{ email: "x@example.com", idempotencyKey: key() }] }, { syncNow: false, performedBy: admin });
    expect(r.results[0].outcome.kind).toBe("created");
    expect(await quotaOf(juan.id)).toEqual({ used: 1, initial_quota: 16 });
    const logs = await listAuditLogs(admin, { action: "invite" });
    expect(logs[0]).toMatchObject({ actorEmail: "admin@example.com", details: { onBehalfOf: "juan@example.com", by: "admin" } });
    // Un egresado común no puede usar la función de administrador.
    await expect(getGraduateActor(juan, juan.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
