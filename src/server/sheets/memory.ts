import { SHEET_HEADERS, type SheetRow, type SheetsClient } from "./types";

type Op = "ensureSheet" | "readRows" | "appendRows" | "updateInvitedBy" | "deleteRows";

/**
 * Hoja de cálculo en memoria para pruebas automatizadas.
 * Permite simular caídas de Google ("down") y el caso más delicado:
 * la escritura se aplica pero la respuesta se pierde ("failAfterWrite").
 */
export class MemorySheetsClient implements SheetsClient {
  rows: Array<[string, string]> = [];
  header: [string, string] | null = null;
  down = false;
  failAfterWriteOnce: Op | null = null;
  calls: Record<Op, number> = { ensureSheet: 0, readRows: 0, appendRows: 0, updateInvitedBy: 0, deleteRows: 0 };

  describe(): string {
    return "memoria";
  }

  private enter(op: Op) {
    this.calls[op]++;
    if (this.down) throw new Error("Google Sheets no disponible (simulado)");
  }

  private exit(op: Op) {
    if (this.failAfterWriteOnce === op) {
      this.failAfterWriteOnce = null;
      throw new Error("Tiempo de espera agotado tras escribir (simulado)");
    }
  }

  async ensureSheet(): Promise<void> {
    this.enter("ensureSheet");
    if (!this.header) this.header = [...SHEET_HEADERS];
  }

  async readRows(): Promise<SheetRow[]> {
    this.enter("readRows");
    return this.rows.map(([guest, invitedBy], i) => ({ rowNumber: i + 2, guest, invitedBy }));
  }

  async appendRows(rows: Array<[string, string]>): Promise<void> {
    this.enter("appendRows");
    this.rows.push(...rows.map((r) => [r[0], r[1]] as [string, string]));
    this.exit("appendRows");
  }

  async updateInvitedBy(rowNumber: number, invitedBy: string): Promise<void> {
    this.enter("updateInvitedBy");
    this.rows[rowNumber - 2][1] = invitedBy;
    this.exit("updateInvitedBy");
  }

  async deleteRows(rowNumbers: number[]): Promise<void> {
    this.enter("deleteRows");
    for (const r of [...new Set(rowNumbers)].sort((a, b) => b - a)) {
      this.rows.splice(r - 2, 1);
    }
    this.exit("deleteRows");
  }
}
