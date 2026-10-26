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
  let json: { client_email?: string; private_key?: string };
  try {
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    json = JSON.parse(text);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no es un JSON válido (ni en texto ni en base64)");
  }
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
