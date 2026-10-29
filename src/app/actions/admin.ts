"use server";

import { revalidatePath } from "next/cache";
import {
  getGraduateActor,
  cancelInvitation,
  cancelInvitationGroup,
  correctInvitationEmail,
  deletePendingUser,
  generateAccessLink,
  importGraduates,
  setUserDisabled,
  setUserName,
  updateRegistrationCode,
} from "@/server/admin";
import { requireAdmin } from "@/server/actor";
import { checkGuestEmails, inviteGroup, type GroupOutcome } from "@/server/invitations";
import { publicMessage } from "@/server/errors";
import { importPool, updatePoolPerson } from "@/server/pool-admin";
import { diagnoseSheet, makeAllPendingDue, reconcileSheet, runSheetSync } from "@/server/sheets/sync";
import { auditSafe } from "@/server/audit";
import { baseUrl, clientIp, getCurrentActor } from "@/lib/session";
import type { FormState } from "@/lib/form-state";

async function readText(form: FormData, field = "text", fileField = "file"): Promise<string> {
  const file = form.get(fileField);
  if (file && typeof file === "object" && "text" in file && file.size > 0) {
    if (file.size > 2_000_000) throw new Error("El archivo es demasiado grande (máximo 2 MB).");
    return await file.text();
  }
  return String(form.get(field) ?? "");
}

function fail(err: unknown): FormState {
  if (err instanceof Error && err.message.startsWith("El archivo")) return { ok: false, message: err.message };
  return { ok: false, message: publicMessage(err) };
}

export async function importGraduatesAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    const report = await importGraduates(await getCurrentActor(), await readText(form));
    revalidatePath("/admin", "layout");
    return {
      ok: true,
      message: `Importación lista: ${report.added.length} nuevos, ${report.updated.length} actualizados, ${report.unchanged.length} sin cambios, ${report.duplicates.length} repetidos, ${report.invalid.length} inválidos.`,
      data: report,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function userAction(_p: FormState, form: FormData): Promise<FormState> {
  const actor = await getCurrentActor();
  const userId = String(form.get("userId") ?? "");
  const op = String(form.get("op") ?? "");
  try {
    let message = "Listo.";
    let data: unknown;
    if (op === "disable") {
      await setUserDisabled(actor, userId, true);
      message = "Cuenta deshabilitada.";
    } else if (op === "enable") {
      await setUserDisabled(actor, userId, false);
      message = "Cuenta habilitada.";
    } else if (op === "delete") {
      await deletePendingUser(actor, userId);
      message = "Egresado quitado de la lista.";
    } else if (op === "rename") {
      await setUserName(actor, userId, form.get("name"));
      message = "Nombre actualizado.";
    } else if (op === "link") {
      data = { link: await generateAccessLink(actor, userId, await baseUrl()) };
      message = "Enlace generado. Vale 24 horas y se puede usar una sola vez. Enviáselo solo a esa persona.";
    } else return { ok: false, message: "Operación desconocida." };
    revalidatePath("/admin", "layout");
    return { ok: true, message, data };
  } catch (err) {
    return fail(err);
  }
}

export async function cancelInvitationAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    await cancelInvitation(await getCurrentActor(), String(form.get("invitationId") ?? ""), form.get("reason"));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Invitación anulada. Se liberó la entrada y se actualizará la hoja." };
  } catch (err) {
    return fail(err);
  }
}

const DEFAULT_DELETE_REASON = "Borrada por el administrador (el egresado se arrepintió)";

/** Borra un mail anotado (o un grupo entero) desde "Quién invitó": la entrada vuelve al egresado. */
export async function deleteInvitationAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    const actor = await getCurrentActor();
    const reason = String(form.get("reason") ?? "").trim() || DEFAULT_DELETE_REASON;
    const groupId = String(form.get("groupId") ?? "");
    if (groupId) {
      const emails = await cancelInvitationGroup(actor, groupId, reason);
      revalidatePath("/admin", "layout");
      return { ok: true, message: `Se ${emails.length === 1 ? "borró 1 invitación" : `borraron ${emails.length} invitaciones`}. Las entradas volvieron al egresado.` };
    }
    await cancelInvitation(actor, String(form.get("invitationId") ?? ""), reason);
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Invitación borrada. La entrada volvió al egresado." };
  } catch (err) {
    return fail(err);
  }
}

export async function correctInvitationAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    await correctInvitationEmail(await getCurrentActor(), String(form.get("invitationId") ?? ""), form.get("email"));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Email corregido. La hoja se actualizará automáticamente." };
  } catch (err) {
    return fail(err);
  }
}

export async function importPoolAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    // En un archivo CSV cada persona queda como su propio grupo.
    const r = await importPool(await getCurrentActor(), await readText(form), { grouping: "each" });
    revalidatePath("/admin", "layout");
    return {
      ok: true,
      message: `${r.added.length} agregados, ${r.duplicates.length} duplicados, ${r.invalid.length} inválidos, ${r.conflicts.length} rechazados por estar ya invitados.`,
      data: r,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function poolPersonAction(_p: FormState, form: FormData): Promise<FormState> {
  const op = String(form.get("op") ?? "");
  if (op !== "retire" && op !== "reactivate" && op !== "delete") return { ok: false, message: "Operación desconocida." };
  try {
    await updatePoolPerson(await getCurrentActor(), String(form.get("id") ?? ""), op);
    revalidatePath("/admin", "layout");
    return { ok: true, message: op === "retire" ? "Persona desactivada." : op === "reactivate" ? "Persona reactivada." : "Persona eliminada del pool." };
  } catch (err) {
    return fail(err);
  }
}

export async function syncAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    const actor = requireAdmin(await getCurrentActor());
    const op = String(form.get("op") ?? "sync");
    if (op === "diagnose") {
      const diag = await diagnoseSheet();
      return { ok: true, message: "Diagnóstico completo.", data: diag };
    }
    let result;
    if (op === "reconcile") {
      result = await reconcileSheet("admin");
    } else {
      await makeAllPendingDue();
      result = await runSheetSync({ trigger: "admin", waitForLeaseMs: 8000, maxBatches: 20 });
    }
    await auditSafe({
      actorId: actor.id,
      actorEmail: actor.email,
      action: op === "reconcile" ? "sheet_reconcile" : "sheet_sync_manual",
      result: result.status === "ok" || result.status === "idle" ? "success" : "error",
      details: { ...result },
    });
    revalidatePath("/admin", "layout");
    const labels: Record<string, string> = {
      ok: `Sincronización correcta: ${result.appended} filas agregadas, ${result.updated} corregidas, ${result.removed} eliminadas.`,
      idle: "No había tareas pendientes.",
      busy: "Otra sincronización está en curso. Probá de nuevo en unos segundos.",
      not_configured: "Google Sheets todavía no está configurado (faltan variables de entorno).",
      error: `Google Sheets devolvió un error: ${result.error ?? "desconocido"}. Las tareas siguen pendientes y se reintentarán solas.`,
    };
    return { ok: result.status === "ok" || result.status === "idle", message: labels[result.status] };
  } catch (err) {
    if (err instanceof Error && !("code" in err)) return { ok: false, message: `Error: ${err.message.slice(0, 300)}` };
    return fail(err);
  }
}

export async function settingsAction(_p: FormState, form: FormData): Promise<FormState> {
  try {
    const code = form.get("op") === "clear" ? "" : form.get("registrationCode");
    await updateRegistrationCode(await getCurrentActor(), code);
    revalidatePath("/admin", "layout");
    return { ok: true, message: code ? "Código de registro actualizado." : "Código de registro desactivado." };
  } catch (err) {
    return fail(err);
  }
}

/** El administrador revisa una lista en nombre de un egresado (ve quién anotó cada mail). */
export async function adminCheckEmailsAction(graduateId: string, emails: string[]) {
  try {
    const grad = await getGraduateActor(await getCurrentActor(), graduateId);
    return await checkGuestEmails(grad, emails, { revealInviter: true });
  } catch (err) {
    return { error: publicMessage(err) } as const;
  }
}

/** El administrador anota un grupo en nombre de un egresado (usa el cupo del egresado; queda auditado). */
export async function adminInviteGroupAction(graduateId: string, emails: string[], idempotencyKey: string): Promise<GroupOutcome> {
  try {
    const admin = requireAdmin(await getCurrentActor());
    const grad = await getGraduateActor(admin, graduateId);
    const result = await inviteGroup(grad, { emails, idempotencyKey, ip: await clientIp() }, { performedBy: admin });
    revalidatePath("/admin", "layout");
    return result;
  } catch (err) {
    return { kind: "validation", message: publicMessage(err) };
  }
}
