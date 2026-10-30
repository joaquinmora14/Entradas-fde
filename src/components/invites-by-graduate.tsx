"use client";

import { useState } from "react";
import Link from "next/link";
import type { InviterSummary } from "@/server/admin";
import type { FormState } from "@/lib/form-state";
import { ActionForm } from "./action-form";
import { CopyButton } from "./copy-button";
import { SubmitButton } from "./submit-button";
import { Badge, Card, EmptyState, cx, dangerButtonClass, formatDateTime, inputClass } from "./ui";

type Show = "with" | "all" | "without";

/** Vista del admin: cada egresado con sus invitados. Se filtra al instante por nombre o mail. */
export function InvitesByGraduate({
  graduates,
  remove,
}: {
  graduates: InviterSummary[];
  /** Borra un mail (invitationId) o un grupo entero (groupId); la entrada vuelve al egresado. */
  remove: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("with");
  const term = q.trim().toLowerCase();
  const total = graduates.reduce((n, g) => n + g.used, 0);
  const withInvites = graduates.filter((g) => g.used > 0).length;

  const visible = graduates
    .filter((g) => (show === "with" ? g.used > 0 : show === "without" ? g.used === 0 : true))
    .map((g) => {
      if (!term) return { g, groups: g.groups, matchedGraduate: false };
      const matchedGraduate = g.name.toLowerCase().includes(term) || g.email.includes(term);
      // Si se busca un invitado, se muestran solo los grupos donde aparece.
      const groups = matchedGraduate ? g.groups : g.groups.filter((gr) => gr.emails.some((e) => e.toLowerCase().includes(term)));
      return { g, groups, matchedGraduate };
    })
    .filter(({ groups, matchedGraduate }) => !term || matchedGraduate || groups.length > 0);

  const chip = (value: Show, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setShow(value)}
      aria-pressed={show === value}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold",
        show === value ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {label}
      <span className={cx("rounded-full px-1.5 text-xs tabular-nums", show === value ? "bg-white/25 text-white" : "bg-slate-100 text-slate-600")}>{count}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <Card>
        <p className="text-sm text-slate-600">
          <strong className="text-slate-900">{total}</strong> entradas dadas por <strong className="text-slate-900">{withInvites}</strong> de {graduates.length} egresados.
        </p>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar egresado o invitado…"
          aria-label="Buscar egresado o invitado"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cx(inputClass, "mt-3")}
        />
        <div role="group" aria-label="Qué egresados mostrar" className="mt-3 flex flex-wrap gap-2">
          {chip("with", "Invitaron a alguien", withInvites)}
          {chip("without", "Todavía no invitaron", graduates.length - withInvites)}
          {chip("all", "Todos", graduates.length)}
        </div>
      </Card>

      {visible.length === 0 ? (
        <EmptyState title="No hay resultados">{term ? "Probá con otra búsqueda." : null}</EmptyState>
      ) : (
        visible.map(({ g, groups }) => (
          <Card key={g.id}>
            <div data-testid="graduate-invites" className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={`/admin/egresados/${g.id}`} className="text-lg font-semibold text-brand-700 hover:underline">
                  {g.name}
                </Link>
                <p className="break-all text-xs text-slate-500">{g.email}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {g.status === "pending" ? <Badge tone="amber">Sin cuenta</Badge> : g.status === "disabled" ? <Badge tone="red">Deshabilitado</Badge> : null}
                <Badge tone={g.used > 0 ? "brand" : "slate"}>
                  {g.used} {g.used === 1 ? "invitado" : "invitados"} · quedan {g.initialQuota - g.used}
                </Badge>
              </div>
            </div>
            {groups.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">Todavía no invitó a nadie.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {groups.map((gr) => (
                  <div key={gr.id} className="rounded-xl border border-slate-200 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-slate-500">
                        <span className="font-semibold text-slate-700">{gr.emails.length === 1 ? "1 persona" : `Grupo de ${gr.emails.length}`}</span> ·{" "}
                        {gr.source === "pool" ? "desde fuera de lista" : "entradas individuales"} · {formatDateTime(gr.createdAt)}
                      </p>
                      {gr.emails.length > 1 ? (
                        <ActionForm
                          action={remove}
                          hidden={{ groupId: gr.id }}
                          confirm={`¿Borrar el grupo entero (${gr.emails.length} mails) que anotó ${g.name}?\n\n${gr.emails.join("\n")}\n\nLas ${gr.emails.length} entradas vuelven a ${g.name} y se quitan de la planilla.`}
                        >
                          <SubmitButton className={cx(dangerButtonClass, "px-2.5 py-1.5 text-xs")} pendingText="Borrando…">
                            Borrar grupo
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                    <ul className="mt-1 divide-y divide-slate-100">
                      {gr.emails.map((e, idx) => (
                        <li key={e} className="flex flex-wrap items-center gap-2 py-1">
                          <span
                            className={cx(
                              "min-w-0 flex-1 select-all break-all text-sm font-medium",
                              term && e.toLowerCase().includes(term) ? "rounded bg-amber-100 px-1" : "",
                            )}
                          >
                            {e}
                          </span>
                          {gr.sent[idx] ? <Badge tone="green">Enviada</Badge> : <Badge tone="amber">Sin enviar</Badge>}
                          <CopyButton text={e} />
                          <ActionForm
                            action={remove}
                            hidden={{ invitationId: gr.invitationIds[idx] }}
                            confirm={`¿Borrar ${e} de las invitaciones de ${g.name}?\n\nLa entrada vuelve a ${g.name} y se quita de la planilla.`}
                          >
                            <SubmitButton className={cx(dangerButtonClass, "px-2.5 py-1.5 text-xs")} pendingText="Borrando…">
                              Borrar
                            </SubmitButton>
                          </ActionForm>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
