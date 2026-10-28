// Pruebas masivas de fidelidad: un mail tiene que ser EXACTAMENTE el mismo (sin perder ni
// cambiar ningún carácter, salvo pasar a minúsculas) en cada etapa:
// texto pegado → extracción → revisión → base de datos → paneles → planilla → pool.
import { describe, expect, it } from "vitest";
import { analyzeEmailText } from "@/lib/extract-emails";
import { parseEmail } from "@/server/email";
import { checkGuestEmails, inviteFromPool, inviteGroup, listMyInvitations } from "@/server/invitations";
import { listInvitations } from "@/server/admin";
import { checkPoolEmails, getPoolBoard, importPool } from "@/server/pool-admin";
import { MemorySheetsClient } from "@/server/sheets/memory";
import { runSheetSync, setSheetsClientForTests } from "@/server/sheets/sync";
import { getDb } from "@/server/db";
import { key, makeUser } from "./support/factory";

// ---------------------------------------------------------------------------
// Generador determinístico (misma semilla = mismos casos, reproducible)
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_%+-";
const LABEL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";
const TLDS = ["com", "com.ar", "ar", "net", "org", "edu.ar", "co.uk", "io", "uy", "gob.ar", "info"];
const PROVIDERS = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com.ar", "icloud.com", "live.com.ar", "hotmail.com.ar"];
const NAMES = ["Lucía Pérez", "Juan Martín Gómez", "Ana Muñoz", "Tomás O'Brien", "Sofía Álvarez", "Nicolás Díaz", "Iñaki Ortiz", "Zoe"];

function makeGen(seed: number) {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const pick = <T,>(a: T[]) => a[int(a.length)];
  const chars = (set: string, min: number, max: number) =>
    Array.from({ length: min + int(max - min + 1) }, () => set[int(set.length)]).join("");
  const randomCase = (s: string) => s.split("").map((c) => (r() < 0.25 ? c.toUpperCase() : c)).join("");

  function local(): string {
    const parts = Array.from({ length: 1 + int(3) }, () => chars(LOCAL_CHARS, 1, 9));
    // A veces un apóstrofe interno (o'brien).
    if (r() < 0.08) parts[0] = `${parts[0]}'${chars(LOCAL_CHARS, 1, 5)}`;
    return parts.join(".");
  }
  function label(): string {
    const body = chars(LABEL_CHARS, 0, 8);
    const edge = () => chars("abcdefghijklmnopqrstuvwxyz0123456789", 1, 1);
    return body.length ? `${edge()}${body}${edge()}`.replace(/^-+|-+$/g, "x") : edge();
  }
  function domain(): string {
    if (r() < 0.5) return pick(PROVIDERS);
    const labels = Array.from({ length: 1 + int(2) }, label);
    return `${labels.join(".")}.${pick(TLDS)}`;
  }
  /** Un mail válido y su forma esperada (minúsculas). */
  function email(): { text: string; expected: string } {
    const e = `${local()}@${domain()}`;
    return { text: randomCase(e), expected: e.toLowerCase() };
  }
  function dni(): string {
    return r() < 0.5 ? String(30_000_000 + int(20_000_000)) : `${int(50)}.${100 + int(900)}.${100 + int(900)}`;
  }
  /** Mete un mail en un formato realista de lista. */
  function line(e: { text: string }): string {
    const name = pick(NAMES);
    const lower = e.text.toLowerCase();
    switch (int(16)) {
      case 0: return `${name} - ${e.text} - ${dni()}`;
      case 1: return `${name}, ${e.text}, ${dni()}`;
      case 2: return `${name}\t${e.text}\t${dni()}`;
      case 3: return `Nombre: ${name}\nMail: ${e.text}\nDNI: ${dni()}`;
      case 4: return `*${name}* ${e.text}`;
      case 5: return e.text;
      case 6: return `<${e.text}>`;
      case 7: return `(${e.text})`;
      case 8: return `"${e.text}"`;
      case 9: return `${e.text}; `;
      case 10: return `${e.text}.`;
      case 11: return `mailto:${e.text}`;
      case 12: return `*${e.text}*`;
      case 13: return `_${e.text}_`;
      case 14: return `${lower}${dni().replace(/\./g, "")}`; // DNI pegado al mail
      default: return `${lower}DNI ${dni()}`; // texto en mayúsculas pegado al mail
    }
  }
  /** Lista de n mails distintos (también distintos según la identidad de Gmail). */
  function list(n: number) {
    const out: Array<{ text: string; expected: string }> = [];
    const seen = new Set<string>();
    while (out.length < n) {
      const e = email();
      const p = parseEmail(e.expected);
      if (!p.ok || seen.has(p.normalized)) continue;
      seen.add(p.normalized);
      out.push(e);
    }
    const sep = pick(["\n", "\n\n", "\r\n", "\n---\n"]);
    return { items: out, text: out.map(line).join(sep) };
  }
  return { list, email, int };
}

// ---------------------------------------------------------------------------
describe("Fidelidad de los mails en la extracción (miles de casos)", () => {
  it("cada mail generado vale para la app (sanity del generador)", () => {
    const g = makeGen(1);
    for (let i = 0; i < 3000; i++) {
      const e = g.email();
      const p = parseEmail(e.expected);
      expect(p.ok, e.expected).toBe(true);
      if (p.ok) expect(p.original).toBe(e.expected);
    }
  });

  it("20.000 mails en listas con formatos reales: se extraen idénticos, sin perder ni agregar caracteres", () => {
    let total = 0;
    // FIDELITY_LISTS / FIDELITY_SEED permiten correr muchísimos más casos a mano.
    const lists = Number(process.env.FIDELITY_LISTS ?? 4000);
    const first = Number(process.env.FIDELITY_SEED ?? 1);
    for (let seed = first; seed < first + lists; seed++) {
      const g = makeGen(seed);
      const { items, text } = g.list(1 + g.int(9));
      const got = analyzeEmailText(text);
      const expected = items.map((i) => i.expected);
      if (JSON.stringify(got.emails.map((e) => e.email)) !== JSON.stringify(expected)) {
        throw new Error(`Semilla ${seed}\nTexto:\n${text}\nEsperado: ${expected.join(", ")}\nObtenido: ${got.emails.map((e) => e.email).join(", ")}`);
      }
      expect(got.unreadable).toEqual([]);
      total += items.length;
    }
    expect(total).toBeGreaterThan(lists * 3);
    if (process.env.FIDELITY_LISTS) console.log(`Fidelidad: ${total} mails en ${lists} listas sin diferencias`);
  });

  it("la revisión del servidor devuelve exactamente el mismo mail que se extrajo", () => {
    for (let seed = 5000; seed < 7000; seed++) {
      const g = makeGen(seed);
      const { items } = g.list(1 + g.int(5));
      for (const it of items) {
        const p = parseEmail(it.expected);
        expect(p.ok && p.original).toBe(it.expected);
      }
    }
  });
});

describe("Fidelidad de punta a punta (base de datos, paneles, planilla y pool)", () => {
  it("anotar entradas: el mail es idéntico en la vista previa, la base, los paneles y la planilla", async () => {
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    const admin = await makeUser({ email: "admin@example.com", admin: true, graduate: false });
    const grad = await makeUser({ email: "egresado.fidelidad@example.com", name: "Egresado Prueba", quota: 2000 });
    const all: string[] = [];
    for (let seed = 9000; seed < 9060; seed++) {
      const g = makeGen(seed);
      const { items, text } = g.list(1 + g.int(6));
      const extracted = analyzeEmailText(text).emails.map((e) => e.email);
      expect(extracted).toEqual(items.map((i) => i.expected));
      // Solo los que no existen todavía (la identidad de Gmail ignora puntos y +sufijo).
      const check = await checkGuestEmails(grad, extracted);
      const okEmails = check.items.filter((c) => c.status === "ok").map((c) => c.email);
      for (const c of check.items) expect(extracted).toContain(c.email);
      if (okEmails.length) {
        const res = await inviteGroup(grad, { emails: okEmails, idempotencyKey: key() });
        expect(res.kind).toBe("created");
        if (res.kind === "created") expect(res.emails).toEqual(okEmails);
      }
      all.push(...okEmails);
    }
    expect(all.length).toBeGreaterThan(100);
    const db = await getDb().query<{ guest_email: string }>(
      "SELECT guest_email FROM app.invitations WHERE status = 'active' ORDER BY created_at, id",
    );
    expect(new Set(db.rows.map((r) => r.guest_email))).toEqual(new Set(all));
    expect(new Set((await listMyInvitations(grad)).map((i) => i.email))).toEqual(new Set(all));
    expect(new Set((await listInvitations(admin)).map((i) => i.email))).toEqual(new Set(all));
    await runSheetSync({ trigger: "test", maxBatches: 50 });
    expect(new Set(sheet.rows.map((r) => r[0]))).toEqual(new Set(all));
    expect(sheet.rows).toHaveLength(all.length);
    expect(sheet.rows.every((r) => r[1] === "Egresado Prueba")).toBe(true);
  });

  it("fuera de lista: el mail es idéntico al cargarlo, en la lista, al elegirlo y en la planilla", async () => {
    const sheet = new MemorySheetsClient();
    setSheetsClientForTests(sheet);
    const loader = await makeUser({ email: "carga@example.com", name: "Quien Carga" });
    const picker = await makeUser({ email: "elige@example.com", name: "Quien Elige", quota: 2000 });
    const loaded: string[] = [];
    for (let seed = 12000; seed < 12040; seed++) {
      const g = makeGen(seed);
      const { items, text } = g.list(1 + g.int(6));
      const check = await checkPoolEmails(loader, items.map((i) => i.expected));
      const ok = check.items.filter((c) => c.status === "ok").map((c) => c.email);
      const report = await importPool(loader, text);
      expect(report.invalid).toEqual([]);
      for (const e of ok) expect(report.added).toContain(e);
      loaded.push(...report.added);
    }
    expect(loaded.length).toBeGreaterThan(60);
    const board = await getPoolBoard(picker);
    expect(board.available.flatMap((g) => g.people.map((p) => p.email))).toEqual(loaded); // mismo orden de carga y mismos caracteres
    // Darle entrada a cada grupo de la lista.
    const picked: string[] = [];
    for (const g of board.available) {
      const r = await inviteFromPool(picker, { poolGroupId: g.id, idempotencyKey: key() }, { syncNow: false });
      expect(r.kind).toBe("created");
      if (r.kind === "created") {
        expect(r.emails).toEqual(g.people.map((p) => p.email));
        picked.push(...r.emails);
      }
    }
    expect(picked).toEqual(loaded);
    const db = await getDb().query<{ guest_email: string; email: string }>(
      `SELECT i.guest_email, p.email FROM app.pool_people p JOIN app.invitations i ON i.id = p.invitation_id ORDER BY p.seq`,
    );
    expect(db.rows.map((r) => r.guest_email)).toEqual(loaded);
    expect(db.rows.every((r) => r.guest_email === r.email)).toBe(true);
    await runSheetSync({ trigger: "test", maxBatches: 50 });
    expect(sheet.rows.map((r) => r[0])).toEqual(loaded);
  });
});
