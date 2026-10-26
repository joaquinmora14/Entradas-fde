import { NextResponse } from "next/server";
import { getDb } from "@/server/db";

export async function GET() {
  try {
    const { rows } = await getDb().query<{ n: number }>(
      "SELECT count(*) AS n FROM app.schema_migrations",
    );
    return NextResponse.json({ ok: true, db: "ok", migrations: rows[0].n });
  } catch {
    return NextResponse.json({ ok: false, db: "error" }, { status: 503 });
  }
}
