// Normalización y validación de emails.
//
// Regla de identidad global de un invitado: el email normalizado.
//  - se quitan espacios y se pasa a minúsculas;
//  - en Gmail (gmail.com / googlemail.com) se ignoran los puntos y el sufijo "+algo"
//    de la parte local, porque Google entrega esas variantes al mismo buzón.
//    Así "Juan.Perez+fiesta@Gmail.com" y "juanperez@gmail.com" son la misma persona.

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type ParsedEmail =
  | { ok: true; original: string; normalized: string }
  | { ok: false; original: string; reason: string };

export function parseEmail(input: unknown): ParsedEmail {
  const original = typeof input === "string" ? input.normalize("NFKC").trim() : "";
  if (!original) return { ok: false, original, reason: "Ingresá un email." };
  if (original.length > 254) return { ok: false, original, reason: "El email es demasiado largo." };
  const lower = original.toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0 || at === lower.length - 1 || lower.indexOf("@") !== at) {
    return { ok: false, original, reason: "El email no tiene un formato válido." };
  }
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) {
    return { ok: false, original, reason: "El email no tiene un formato válido." };
  }
  if (domain === "gmail.com" || domain === "googlemail.com") {
    domain = "gmail.com";
    // La identidad ignora puntos y "+sufijo"; si no queda nada antes del "+", se usa todo.
    const base = local.split("+")[0].replace(/\./g, "");
    local = base || local.replace(/\./g, "");
  }
  return { ok: true, original: lower, normalized: `${local}@${domain}` };
}

export function normalizeEmail(input: string): string | null {
  const p = parseEmail(input);
  return p.ok ? p.normalized : null;
}
