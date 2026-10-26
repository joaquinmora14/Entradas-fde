// Extracción de emails desde texto libre (listas tipo "Nombre - mail - DNI").
// Es determinística: no envía los datos a ningún servicio externo.
// Se usa en el navegador (vista previa) y en el servidor.

const EMAIL_RE = /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}/gi;

/** Dominios frecuentes y sus errores de tipeo típicos. */
const DOMAIN_FIXES: Record<string, string> = {
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cpm": "gmail.com",
  "gmail.comm": "gmail.com",
  "gmail.om": "gmail.com",
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
  "yahoo.com.ar.": "yahoo.com.ar",
  "icloud.con": "icloud.com",
  "iclod.com": "icloud.com",
  "live.con": "live.com",
};

export interface ExtractedEmail {
  /** Email tal como se va a anotar (minúsculas, sin espacios). */
  email: string;
  /** Corrección sugerida si el dominio parece mal escrito. */
  suggestion?: string;
}

/**
 * Prepara el texto: une "juan @ gmail.com", traduce "arroba"/"(at)" y quita "mailto:".
 */
function prepare(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/mailto:/gi, " ")
    .replace(/\s*(?:\(|\[|\{)\s*(?:arroba|at)\s*(?:\)|\]|\})\s*/gi, "@")
    .replace(/\s+arroba\s+/gi, "@")
    .replace(/([a-z0-9._%+-])\s*@\s*([a-z0-9-])/gi, "$1@$2")
    .replace(/@([a-z0-9-]+)\s+(?:punto|dot)\s+([a-z]{2,})/gi, "@$1.$2")
    .replace(/\.(com|net|org|edu|gob|ar|uy|cl|es)\s+(?:punto|dot)\s+([a-z]{2,})/gi, ".$1.$2");
}

export function extractEmails(text: string): ExtractedEmail[] {
  const found = prepare(text ?? "").match(EMAIL_RE) ?? [];
  const seen = new Set<string>();
  const out: ExtractedEmail[] = [];
  for (const raw of found) {
    const email = raw.toLowerCase().replace(/^[.'_-]+|[.'_-]+$/g, "");
    if (seen.has(email)) continue;
    seen.add(email);
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const fixed = DOMAIN_FIXES[domain];
    out.push(fixed ? { email, suggestion: `${email.slice(0, email.lastIndexOf("@") + 1)}${fixed}` } : { email });
  }
  return out;
}

export const MAX_EMAILS_PER_BATCH = 50;
