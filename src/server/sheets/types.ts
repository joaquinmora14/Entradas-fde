export const SHEET_HEADERS = ["Invitado", "Invitado por"] as const;

export interface SheetRow {
  /** Número de fila en la hoja (1 = encabezado). */
  rowNumber: number;
  guest: string;
  invitedBy: string;
}

/**
 * Operaciones mínimas sobre la hoja "Invitados" (columnas A y B).
 * La implementación real usa la API oficial de Google Sheets; en las pruebas
 * se usa una hoja en memoria con inyección de fallas.
 */
export interface SheetsClient {
  /** Crea la pestaña si no existe y escribe los encabezados si faltan. */
  ensureSheet(): Promise<void>;
  /** Lee todas las filas de datos (sin el encabezado). */
  readRows(): Promise<SheetRow[]>;
  /** Agrega filas al final. */
  appendRows(rows: Array<[string, string]>): Promise<void>;
  /** Reemplaza la columna B de una fila. */
  updateInvitedBy(rowNumber: number, invitedBy: string): Promise<void>;
  /** Elimina filas completas (números de fila originales). */
  deleteRows(rowNumbers: number[]): Promise<void>;
  /** Descripción legible del destino (para diagnóstico). */
  describe(): string;
}
