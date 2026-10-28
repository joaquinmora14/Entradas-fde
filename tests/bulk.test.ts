import { describe, expect, it } from "vitest";
import { analyzeEmailText, extractEmails } from "@/lib/extract-emails";
import { checkGuestEmails, getDashboard, inviteGroup } from "@/server/invitations";
import { getDb } from "@/server/db";
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

  it("no recorta mails con tilde ni toma el asterisco de WhatsApp", () => {
    const a = analyzeEmailText("Lucía Pérez lucía.perez@gmail.com\n*juan.perez@gmail.com*\nmuñoz@gmail.com");
    expect(a.emails.map((e) => e.email)).toEqual(["juan.perez@gmail.com"]);
    expect(a.unreadable).toEqual([
      { text: "lucía.perez@gmail.com", suggestion: "lucia.perez@gmail.com" },
      { text: "muñoz@gmail.com", suggestion: "munoz@gmail.com" },
    ]);
  });

  it("separa mails pegados a otro texto y repara los incompletos", () => {
    const a = analyzeEmailText("juan@gmail.comDNI 40123456\npedro@gmail.com40123456\nmaria@gmail\njose@gmail,com\nraro@@hotmail.com");
    expect(a.emails.map((e) => e.email)).toEqual(["juan@gmail.com", "pedro@gmail.com"]);
    expect(a.unreadable.map((u) => u.suggestion)).toEqual(["maria@gmail.com", "jose@gmail.com", "raro@hotmail.com"]);
  });

  it("las líneas sin mail se cuentan como ignoradas, no como errores", () => {
    const a = analyzeEmailText("Nombre: Lucila\nDNI: 45.123.456\nMail: lucila@gmail.com\n\nNombre: Ema\nMail: ema@hotmail.com");
    expect(a.emails.map((e) => e.email)).toEqual(["lucila@gmail.com", "ema@hotmail.com"]);
    expect(a.unreadable).toEqual([]);
    expect(a.ignoredLines).toBe(3);
  });

  it("no devuelve nada si el texto no tiene mails", () => {
    expect(extractEmails("Juan 40123456\nAna")).toEqual([]);
  });
});

describe("Anotar un grupo (la lista pegada va junta)", () => {
  it("revisa la lista antes de anotar sin modificar nada", async () => {
    const juan = await makeUser({ email: "juan@example.com", name: "Juan" });
    const maria = await makeUser({ email: "maria@example.com", name: "María" });
    await inviteGroup(maria, { emails: ["tomada@example.com"], idempotencyKey: key() }, { syncNow: false });
    await inviteGroup(juan, { emails: ["mia@example.com"], idempotencyKey: key() }, { syncNow: false });
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

  it("anota a todos juntos como un grupo, en el orden de la lista", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    const emails = ["zeta@example.com", "Alfa@Example.com", "medio@example.com"];
    const r = await inviteGroup(juan, { emails, idempotencyKey: key() }, { syncNow: false });
    expect(r).toMatchObject({ kind: "created", emails: ["zeta@example.com", "alfa@example.com", "medio@example.com"], remaining: 13 });
    expect(await count("SELECT count(DISTINCT group_id) AS n FROM app.invitations")).toBe(1);
    const d = await getDashboard(juan);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].items.map((i) => i.email)).toEqual(["zeta@example.com", "alfa@example.com", "medio@example.com"]);
    // Otro grupo después: aparece primero (los más recientes arriba).
    await inviteGroup(juan, { emails: ["otro@example.com"], idempotencyKey: key() }, { syncNow: false });
    expect((await getDashboard(juan)).groups.map((g) => g.items.length)).toEqual([1, 3]);
  });

  it("dentro de un grupo el orden es el de anotación aunque los mails empaten en el mismo milisegundo", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    // Tres mails del mismo grupo anotados con microsegundos de diferencia (el mismo milisegundo).
    await getDb().query(
      `INSERT INTO app.invitations (guest_email, guest_email_normalized, inviter_id, source, group_id, created_at)
       VALUES ('primero@example.com', 'primero@example.com', $1, 'direct', '00000000-0000-4000-8000-0000000000aa', '2026-10-28 12:00:00.123001+00'),
              ('segundo@example.com', 'segundo@example.com', $1, 'direct', '00000000-0000-4000-8000-0000000000aa', '2026-10-28 12:00:00.123002+00'),
              ('tercero@example.com', 'tercero@example.com', $1, 'direct', '00000000-0000-4000-8000-0000000000aa', '2026-10-28 12:00:00.123003+00')`,
      [juan.id],
    );
    const d = await getDashboard(juan);
    expect(d.groups.map((g) => g.items.map((i) => i.email))).toEqual([["primero@example.com", "segundo@example.com", "tercero@example.com"]]);
  });

  it("si no alcanzan las entradas para todo el grupo, no se anota a nadie", async () => {
    const juan = await makeUser({ email: "juan@example.com", quota: 3 });
    const r = await inviteGroup(juan, { emails: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"], idempotencyKey: key() }, { syncNow: false });
    expect(r).toEqual({ kind: "quota_exhausted", needed: 4, remaining: 3 });
    expect(await quotaOf(juan.id)).toEqual({ used: 0, initial_quota: 3 });
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
  });

  it("reintentar el mismo grupo (corte de red) no duplica ni descuenta de más", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    const k = key();
    const input = { emails: ["a@example.com", "b@example.com"], idempotencyKey: k };
    const [x, y] = await Promise.all([inviteGroup(juan, input, { syncNow: false }), inviteGroup(juan, input, { syncNow: false })]);
    const z = await inviteGroup(juan, input, { syncNow: false });
    expect([x.kind, y.kind, z.kind]).toEqual(["created", "created", "created"]);
    if (x.kind === "created" && z.kind === "created") expect(z.groupId).toBe(x.groupId);
    expect(await quotaOf(juan.id)).toEqual({ used: 2, initial_quota: 16 });
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(2);
  });

  it("si mientras revisaba otro egresado anotó a uno del grupo, no se anota a nadie y se avisa cuál", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    const maria = await makeUser({ email: "maria@example.com" });
    const emails = ["uno@example.com", "carrera@example.com", "dos@example.com"];
    const pre = await checkGuestEmails(juan, emails);
    expect(pre.items.every((i) => i.status === "ok")).toBe(true);
    await inviteGroup(maria, { emails: ["Carrera@example.com"], idempotencyKey: key() }, { syncNow: false });
    const r = await inviteGroup(juan, { emails, idempotencyKey: key() }, { syncNow: false });
    expect(r).toEqual({ kind: "conflict", blocked: [{ email: "carrera@example.com", reason: "taken" }] });
    expect(await quotaOf(juan.id)).toEqual({ used: 0, initial_quota: 16 });
    // Al revisar de nuevo, ese queda afuera y los otros dos se anotan juntos.
    const again = await checkGuestEmails(juan, emails);
    const ok = again.items.filter((i) => i.status === "ok").map((i) => i.email);
    expect(ok).toEqual(["uno@example.com", "dos@example.com"]);
    expect(await inviteGroup(juan, { emails: ok, idempotencyKey: key() }, { syncNow: false })).toMatchObject({ kind: "created", emails: ok });
  });

  it("dos egresados anotando grupos que se pisan al mismo tiempo: no hay duplicados ni bloqueos", async () => {
    const users = await Promise.all(Array.from({ length: 5 }, (_, i) => makeUser({ email: `e${i}@example.com` })));
    const pool = Array.from({ length: 8 }, (_, i) => `p${i}@example.com`);
    const results = await Promise.all(
      users.map((u, i) => inviteGroup(u, { emails: [pool[i], pool[i + 1], pool[i + 3]].reverse(), idempotencyKey: key() }, { syncNow: false })),
    );
    expect(results.every((r) => r.kind === "created" || r.kind === "conflict")).toBe(true);
    // Cada mail tiene a lo sumo una invitación y cada grupo se anotó entero o nada.
    expect(await count("SELECT count(*) AS n FROM (SELECT guest_email_normalized FROM app.invitations GROUP BY 1 HAVING count(*) > 1) x")).toBe(0);
    const created = results.filter((r) => r.kind === "created").length;
    expect(created).toBeGreaterThan(0);
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(created * 3);
    expect(await count("SELECT sum(used) AS n FROM app.invitation_quotas")).toBe(created * 3);
  });

  it("rechaza mails inválidos, egresados o a uno mismo sin anotar a nadie", async () => {
    const juan = await makeUser({ email: "juan@example.com" });
    await makeUser({ email: "maria@example.com" });
    for (const bad of [["ok@example.com", "no-es-mail"], ["ok@example.com", "maria@example.com"], ["ok@example.com", "juan@example.com"]]) {
      expect((await inviteGroup(juan, { emails: bad, idempotencyKey: key() }, { syncNow: false })).kind).toBe("validation");
    }
    expect(await count("SELECT count(*) AS n FROM app.invitations")).toBe(0);
    // El mismo mail dos veces es la misma persona: se anota una vez.
    expect(await inviteGroup(juan, { emails: ["x@example.com", "X@example.com"], idempotencyKey: key() }, { syncNow: false })).toMatchObject({
      kind: "created",
      emails: ["x@example.com"],
    });
  });

  it("el administrador puede anotar un grupo en nombre de un egresado usando su cupo y queda auditado", async () => {
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const juan = await makeUser({ email: "juan@example.com", name: "Juan", status: "pending" });
    const grad = await getGraduateActor(admin, juan.id);
    const r = await inviteGroup(grad, { emails: ["x@example.com", "y@example.com"], idempotencyKey: key() }, { syncNow: false, performedBy: admin });
    expect(r.kind).toBe("created");
    expect(await quotaOf(juan.id)).toEqual({ used: 2, initial_quota: 16 });
    const logs = await listAuditLogs(admin, { action: "invite" });
    expect(logs[0]).toMatchObject({ actorEmail: "admin@example.com", details: { onBehalfOf: "juan@example.com", by: "admin", size: 2 } });
    // Un egresado común no puede usar la función de administrador.
    await expect(getGraduateActor(juan, juan.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
