import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { reconcileSheet, runSheetSync } from "@/server/sheets/sync";

export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Procesa el outbox de Google Sheets. Protegido con CRON_SECRET
 * (Vercel Cron envía "Authorization: Bearer <CRON_SECRET>" automáticamente).
 * ?reconcile=1 ejecuta además una reconciliación completa.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await runSheetSync({ trigger: "cron", maxBatches: 20 });
  const url = new URL(req.url);
  const reconcile = url.searchParams.get("reconcile") === "1" ? await reconcileSheet("cron") : undefined;
  return NextResponse.json({ sync: result, reconcile });
}
