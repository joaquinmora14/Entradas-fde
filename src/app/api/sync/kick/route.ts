import { NextResponse } from "next/server";
import { runSheetSync } from "@/server/sheets/sync";

export const maxDuration = 60;

/**
 * Disparador público y seguro del outbox: solo procesa tareas YA vencidas,
 * no recibe parámetros y no devuelve datos. Lo llama un scheduler externo
 * (GitHub Actions, cada 5 minutos) para reintentar sin depender de que
 * alguien use la aplicación. Si no hay nada pendiente cuesta una consulta.
 */
export async function POST() {
  const r = await runSheetSync({ trigger: "kick" });
  return NextResponse.json({ status: r.status });
}

export const GET = POST;
