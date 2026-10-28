// Extracción de emails desde texto libre (listas tipo "Nombre - mail - DNI", mensajes
// de WhatsApp, respuestas de formularios, etc.).
// Es determinística: no envía los datos a ningún servicio externo.
// Se usa en el navegador (vista previa) y en el servidor.

/**
 * Caracteres que los proveedores reales aceptan en la parte local (incluido el apóstrofe
 * interno, como en o'brien@…). Se excluyen a
 * propósito los símbolos raros del RFC (* = ' ` { } | ! # …) porque en texto pegado
 * casi siempre son formato (p. ej. *negrita* de WhatsApp) y no parte del mail.
 * La lookbehind evita "recortar" un mail con tilde: en "lucía.perez@gmail.com" no se
 * toma "a.perez@gmail.com".
 */
const EMAIL_RE = /(?<![\p{L}\p{N}._%+-])[a-z0-9._%+-]+(?:'[a-z0-9._%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?![\p{L}])/giu;
const FULL_EMAIL_RE = /^[a-z0-9._%+-]+(?:'[a-z0-9._%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;

const PROVIDERS = ["gmail", "hotmail", "outlook", "yahoo", "icloud", "live", "msn", "protonmail", "aol"];

/** Dominios frecuentes y sus errores de tipeo típicos. */
const DOMAIN_FIXES: Record<string, string> = {
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cpm": "gmail.com",
  "gmail.comm": "gmail.com",
  "gmail.om": "gmail.com",
  "gmail.vom": "gmail.com",
  "gmail.xom": "gmail.com",
  "gmai.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gmail.com.ar": "gmail.com",
  "hotmail.con": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmil.com": "hotmail.com",
  "hotmail.cm": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "homail.com": "hotmail.com",
  "hotmail.com.ar.": "hotmail.com.ar",
  "outlook.con": "outlook.com",
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "yahoo.con": "yahoo.com",
  "yaho.com": "yahoo.com",
  "icloud.con": "icloud.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
  "live.con": "live.com",
};

export interface ExtractedEmail {
  /** Email tal como se va a anotar (minúsculas, sin espacios). */
  email: string;
  /** Corrección sugerida si el dominio parece mal escrito. */
  suggestion?: string;
}

export interface UnreadableEmail {
  /** El texto tal como estaba (parece un mail pero no se pudo leer). */
  text: string;
  /** Corrección propuesta, si se puede deducir. */
  suggestion?: string;
}

export interface TextAnalysis {
  emails: ExtractedEmail[];
  /** Cosas con "@" que no son un mail válido. */
  unreadable: UnreadableEmail[];
  /** Líneas sin ningún mail (nombres, DNI, etc.): se ignoran, no son errores. */
  ignoredLines: number;
  /** Mails que aparecían más de una vez en el texto (se toman una sola vez). */
  repeated: string[];
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Prepara el texto: une "juan @ gmail.com", traduce "arroba"/"(at)", quita "mailto:" y
 * separa un mail pegado a otra palabra ("juan@gmail.comDNI").
 */
function prepare(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿­]/g, "") // caracteres invisibles
    .replace(/[＠﹫]/g, "@") // arrobas "anchas"
    .replace(/mailto:/gi, " ")
    .replace(/\s*(?:\(|\[|\{)\s*(?:arroba|at)\s*(?:\)|\]|\})\s*/gi, "@")
    .replace(/\s+arroba\s+/gi, "@")
    .replace(/([a-z0-9._%+-])\s*@\s*([a-z0-9-])/gi, "$1@$2")
    .replace(/@([a-z0-9-]+)\s+(?:punto|dot)\s+([a-z]{2,})/gi, "@$1.$2")
    .replace(/\.(com|net|org|edu|gob|ar|uy|cl|es)\s+(?:punto|dot)\s+([a-z]{2,})/gi, ".$1.$2")
    // "juan@gmail.comDNI" / "juan@gmail.com40123456": se separa SOLO si lo que sigue no puede
    // ser parte del dominio (números, mayúsculas, o una palabra en minúsculas que no sigue
    // con "." o "-"). Así "x@gmail.company.org" (un dominio real) no se toca.
    .replace(new RegExp(`@(?:${PROVIDERS.join("|")})\\.com`, "gi"), (m: string, offset: number, all: string) => {
      const rest = all.slice(offset + m.length);
      const glued = /^[0-9A-Z]/.test(rest) || /^[a-z]+(?:$|[^a-z0-9.-])/.test(rest);
      return glued ? `${m} ` : m;
    });
}

function suggestionFor(domain: string, local: string): string | undefined {
  const fixed = DOMAIN_FIXES[domain];
  return fixed ? `${local}@${fixed}` : undefined;
}

/** Intenta reparar algo que parece un mail ("juan@gmail", "juan@gmail,com", "lucía@gmail.com"). */
function repair(token: string): string | undefined {
  let t = stripAccents(token.toLowerCase())
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .replace(/,(com|net|org|ar)\b/g, ".$1")
    .replace(/\.{2,}/g, ".")
    .replace(/@{2,}/g, "@");
  const at = t.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = t.slice(0, at).replace(/[^a-z0-9._%+-]/g, "");
  let domain = t.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
  if (PROVIDERS.includes(domain)) domain = `${domain}.com`;
  domain = DOMAIN_FIXES[domain] ?? domain;
  t = `${local}@${domain}`;
  return FULL_EMAIL_RE.test(t) ? t : undefined;
}

/**
 * Limpia un mail encontrado SIN perder caracteres válidos:
 * - nunca quita "_", "-", "+" o "%" del principio salvo que sea cursiva de WhatsApp (_mail_);
 * - quita solo puntos sueltos al principio (un mail no puede empezar con ".");
 * - si el final del dominio pasa de minúscula a mayúscula ("empresa.comDNI") corta ahí.
 */
/** Terminaciones de dominio frecuentes (para separar "comDNI", "co.ukNombre", etc.). */
const KNOWN_TLDS = [
  "com", "net", "org", "edu", "gob", "gov", "mil", "int", "info", "biz", "app", "dev", "io", "me", "tv",
  "ar", "uy", "cl", "py", "bo", "pe", "ec", "ve", "co", "mx", "br", "es", "pt", "it", "fr", "de", "uk",
  "us", "ca", "au", "nz", "ch", "nl", "be", "il", "eu",
].join("|");

function cleanMatch(raw: string, line: string): string {
  let m = raw;
  const at = m.lastIndexOf("@");
  const domain = m.slice(at + 1);
  const lastDot = domain.lastIndexOf(".");
  const tld = domain.slice(lastDot + 1);
  // Solo se corta si lo anterior es una terminación conocida escrita en minúsculas y lo que
  // sigue es una palabra que empieza en mayúscula ("comDNI", "comNombre"). Un dominio con
  // mayúsculas mezcladas ("Hotmail.CoM") NO se toca.
  const glued = new RegExp(`^(${KNOWN_TLDS})([A-Z][A-Za-z]+)$`).exec(tld);
  if (glued) m = m.slice(0, at + 1 + lastDot + 1 + glued[1].length);
  if (m.startsWith("_")) {
    const start = line.indexOf(raw);
    const after = line[start + raw.length];
    if (after === "_") m = m.slice(1); // cursiva de WhatsApp: _juan@gmail.com_
  }
  m = m.replace(/^\.+/, "");
  return m.toLowerCase();
}

export function analyzeEmailText(text: string): TextAnalysis {
  const prepared = prepare(text ?? "");
  const seen = new Set<string>();
  const emails: ExtractedEmail[] = [];
  const unreadable: UnreadableEmail[] = [];
  const seenBad = new Set<string>();
  const repeated: string[] = [];
  let ignoredLines = 0;

  for (const line of prepared.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const found = line.match(EMAIL_RE) ?? [];
    for (const raw of found) {
      const email = cleanMatch(raw, line);
      if (seen.has(email)) {
        repeated.push(email);
        continue;
      }
      seen.add(email);
      const at = email.lastIndexOf("@");
      const sug = suggestionFor(email.slice(at + 1), email.slice(0, at));
      emails.push(sug ? { email, suggestion: sug } : { email });
    }
    // Lo que tiene "@" y no se pudo leer como mail completo.
    const rest = found.reduce((acc, f) => acc.split(f).join(" "), line);
    const tokens = rest.split(/[\s;|<>()[\]"]+/).filter((t) => t.includes("@"));
    for (const tok of tokens) {
      const clean = tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!clean || clean === "@" || seenBad.has(clean)) continue;
      // "juan@gmail,com" llega partido por la coma: se repara completo.
      seenBad.add(clean);
      const suggestion = repair(clean);
      if (suggestion && seen.has(suggestion)) continue;
      unreadable.push(suggestion ? { text: clean, suggestion } : { text: clean });
    }
    if (found.length === 0 && tokens.length === 0) ignoredLines++;
  }
  return { emails, unreadable, ignoredLines, repeated };
}

export function extractEmails(text: string): ExtractedEmail[] {
  return analyzeEmailText(text).emails;
}

export const MAX_EMAILS_PER_BATCH = 50;
