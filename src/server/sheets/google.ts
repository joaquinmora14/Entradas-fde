import { GoogleAuth } from "google-auth-library";
import { SHEET_HEADERS, type SheetRow, type SheetsClient } from "./types";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const REQUEST_TIMEOUT_MS = 15_000;

export interface GoogleSheetsConfig {
  spreadsheetId: string;
  tab: string;
  clientEmail: string;
  privateKey: string;
}

/** Lee la configuración desde variables de entorno. Devuelve null si falta algo. */
export function googleSheetsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GoogleSheetsConfig | null {
  const spreadsheetId = env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!spreadsheetId || !raw) return null;
  const json = parseServiceAccount(raw);
  if (!json.client_email || !json.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no contiene client_email/private_key");
  }
  return {
    spreadsheetId,
    tab: env.GOOGLE_SHEETS_TAB?.trim() || "Invitados",
    clientEmail: json.client_email,
    privateKey: json.private_key.replace(/\\n/g, "\n"),
  };
}

/**
 * Interpreta el JSON de la cuenta de servicio tolerando errores típicos al pegarlo
 * en un panel web (comillas envolventes, saltos de línea reales dentro de la clave,
 * base64). Los mensajes de error nunca incluyen el contenido de la clave.
 */
export function parseServiceAccount(raw: string): { client_email?: string; private_key?: string } {
  let text = raw.trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"') && !text.startsWith('"{'))) {
    text = text.slice(1, -1).trim();
  }
  if (!text.startsWith("{")) {
    const decoded = Buffer.from(text, "base64").toString("utf8").trim();
    if (decoded.startsWith("{")) text = decoded;
  }
  const attempts = [
    text,
    // Saltos de línea reales dentro de los strings (p. ej. la clave PEM pegada "desescapada").
    text.replace(/\r?\n/g, "\\n"),
    text.replace(/\r?\n/g, ""),
  ];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // probar la siguiente variante
    }
  }
  const first = text.slice(0, 1) || "(vacío)";
  const last = text.slice(-1) || "(vacío)";
  throw new Error(
    `GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido (largo ${text.length}, empieza con "${first}", termina con "${last}"; ` +
      `${text.includes('"private_key"') ? "contiene" : "NO contiene"} private_key, ` +
      `${text.includes('"client_email"') ? "contiene" : "NO contiene"} client_email)`,
  );
}

/** Error de configuración legible (sin secretos), o null si está bien o no configurado. */
export function googleSheetsConfigError(): string | null {
  try {
    googleSheetsConfigFromEnv();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

export class GoogleSheetsClient implements SheetsClient {
  private auth: GoogleAuth;
  private sheetId: number | null = null;

  constructor(private readonly cfg: GoogleSheetsConfig) {
    this.auth = new GoogleAuth({
      credentials: { client_email: cfg.clientEmail, private_key: cfg.privateKey },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  describe(): string {
    return `${this.cfg.spreadsheetId} / ${this.cfg.tab}`;
  }

  private async request<T>(method: string, url: string, data?: unknown): Promise<T> {
    const client = await this.auth.getClient();
    const res = await client.request<T>({ method, url, data, timeout: REQUEST_TIMEOUT_MS, retry: false });
    return res.data;
  }

  private range(a1: string): string {
    return encodeURIComponent(`${quoteTab(this.cfg.tab)}!${a1}`);
  }

  async ensureSheet(): Promise<void> {
    if (this.sheetId === null) {
      const meta = await this.request<{ sheets: Array<{ properties: { sheetId: number; title: string } }> }>(
        "GET",
        `${API}/${this.cfg.spreadsheetId}?fields=sheets.properties(sheetId,title)`,
      );
      const found = meta.sheets.find((s) => s.properties.title === this.cfg.tab);
      if (found) {
        this.sheetId = found.properties.sheetId;
      } else if (meta.sheets.length === 1) {
        // Planilla nueva con una sola pestaña genérica: se renombra a "Invitados".
        const only = meta.sheets[0].properties;
        await this.request("POST", `${API}/${this.cfg.spreadsheetId}:batchUpdate`, {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId: only.sheetId, title: this.cfg.tab },
                fields: "title",
              },
            },
          ],
        });
        this.sheetId = only.sheetId;
      } else {
        const res = await this.request<{ replies: Array<{ addSheet: { properties: { sheetId: number } } }> }>(
          "POST",
          `${API}/${this.cfg.spreadsheetId}:batchUpdate`,
          { requests: [{ addSheet: { properties: { title: this.cfg.tab } } }] },
        );
        this.sheetId = res.replies[0].addSheet.properties.sheetId;
      }
    }
    const header = await this.request<{ values?: string[][] }>(
      "GET",
      `${API}/${this.cfg.spreadsheetId}/values/${this.range("A1:B1")}`,
    );
    const h = header.values?.[0] ?? [];
    if (h[0] !== SHEET_HEADERS[0] || h[1] !== SHEET_HEADERS[1]) {
      if (!h[0] && !h[1]) {
        await this.request(
          "PUT",
          `${API}/${this.cfg.spreadsheetId}/values/${this.range("A1:B1")}?valueInputOption=RAW`,
          { values: [[...SHEET_HEADERS]] },
        );
      } else if (h[0]?.includes("@")) {
        throw new Error("La fila 1 de la hoja contiene datos en lugar de los encabezados 'Invitado' / 'Invitado por'");
      }
    }
  }

  async readRows(): Promise<SheetRow[]> {
    const res = await this.request<{ values?: string[][] }>(
      "GET",
      `${API}/${this.cfg.spreadsheetId}/values/${this.range("A2:B")}?majorDimension=ROWS`,
    );
    return (res.values ?? []).map((v, i) => ({
      rowNumber: i + 2,
      guest: String(v[0] ?? ""),
      invitedBy: String(v[1] ?? ""),
    }));
  }

  async appendRows(rows: Array<[string, string]>): Promise<void> {
    if (rows.length === 0) return;
    await this.request(
      "POST",
      `${API}/${this.cfg.spreadsheetId}/values/${this.range("A:B")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: rows },
    );
  }

  async updateInvitedBy(rowNumber: number, invitedBy: string): Promise<void> {
    await this.request(
      "PUT",
      `${API}/${this.cfg.spreadsheetId}/values/${this.range(`B${rowNumber}`)}?valueInputOption=RAW`,
      { values: [[invitedBy]] },
    );
  }

  async deleteRows(rowNumbers: number[]): Promise<void> {
    if (rowNumbers.length === 0) return;
    if (this.sheetId === null) await this.ensureSheet();
    const sorted = [...new Set(rowNumbers)].sort((a, b) => b - a);
    await this.request("POST", `${API}/${this.cfg.spreadsheetId}:batchUpdate`, {
      requests: sorted.map((r) => ({
        deleteDimension: {
          range: { sheetId: this.sheetId, dimension: "ROWS", startIndex: r - 1, endIndex: r },
        },
      })),
    });
  }
}
