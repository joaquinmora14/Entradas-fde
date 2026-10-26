import type { Metadata } from "next";
import { connection } from "next/server";
import { after } from "next/server";
import { PublicBoardTable } from "@/components/public-board";
import { PageTitle, Stat } from "@/components/ui";
import { getPublicBoard } from "@/server/public";
import { runSheetSync } from "@/server/sheets/sync";

export const metadata: Metadata = { title: "Cupos" };

export default async function CuposPage() {
  await connection();
  const board = await getPublicBoard();
  after(() => runSheetSync({ trigger: "page" }).catch(() => {}));
  return (
    <div className="space-y-5">
      <PageTitle title="Cupos de entradas" subtitle="Entradas usadas y disponibles de cada egresado. Se actualiza en tiempo real." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Egresados" value={board.graduates.length} />
        <Stat label="Entradas usadas" value={board.totals.used} />
        <Stat label="Entradas disponibles" value={board.totals.remaining} tone="brand" />
        <Stat label="Disponibles en el pool" value={board.poolAvailable} />
      </div>
      <PublicBoardTable graduates={board.graduates} />
    </div>
  );
}
