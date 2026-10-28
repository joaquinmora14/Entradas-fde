"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { analyzeEmailText, MAX_EMAILS_PER_BATCH, type ExtractedEmail, type UnreadableEmail } from "@/lib/extract-emails";
import { UnreadableBox } from "./unreadable-box";
import type { BatchItemResult, CheckedEmail, CheckStatus } from "@/server/invitations";
import { Alert, Badge, buttonClass, cx, inputClass, secondaryButtonClass } from "./ui";

type CheckResult = { items: CheckedEmail[]; remaining: number } | { error: string };
type SubmitResult = { results: BatchItemResult[]; remaining: number } | { error: string };

const STATUS: Record<CheckStatus, { label: string; tone: "green" | "amber" | "red" | "slate" }> = {
  ok: { label: "Se puede anotar", tone: "green" },
  invalid: { label: "Mail inválido", tone: "red" },
  repeated: { label: "Repetido en la lista", tone: "slate" },
  mine: { label: "Ya lo anotaste", tone: "slate" },
  taken: { label: "Ya tiene entrada", tone: "red" },
  graduate: { label: "Es egresado", tone: "slate" },
  self: { label: "Sos vos", tone: "slate" },
};

const BLOCKED_REASON: Record<CheckStatus, string> = {
  ok: "",
  repeated: "",
  invalid: "no es un mail válido",
  mine: "ya lo habías anotado vos",
  taken: "ya tiene entrada de otro egresado",
  graduate: "es egresado, ya tiene su lugar",
  self: "sos vos",
};

function outcomeText(r: BatchItemResult): { text: string; tone: "green" | "amber" | "red" } {
  const o = r.outcome;
  switch (o.kind) {
    case "created":
      return o.sync === "synced" ? { text: "Anotado", tone: "green" } : { text: "Anotado · planilla pendiente", tone: "amber" };
    case "duplicate":
      return { text: "Ya tenía entrada: no se anotó", tone: "red" };
    case "quota_exhausted":
      return { text: "Sin entradas disponibles: no se anotó", tone: "red" };
    case "validation":
      return { text: o.message, tone: "red" };
    case "error":
      return { text: "Error temporal: probá de nuevo", tone: "red" };
  }
}

export function BulkInviteForm({
  check,
  submit,
  remaining,
  who = "vos",
}: {
  check: (emails: string[]) => Promise<CheckResult>;
  submit: (items: Array<{ email: string; idempotencyKey: string }>) => Promise<SubmitResult>;
  remaining: number;
  /** "vos" para el egresado; el nombre del egresado cuando anota un administrador. */
  who?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [extracted, setExtracted] = useState<ExtractedEmail[]>([]);
  const [checked, setChecked] = useState<CheckedEmail[] | null>(null);
  const [left, setLeft] = useState(remaining);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<BatchItemResult[] | null>(null);
  const [unreadable, setUnreadable] = useState<UnreadableEmail[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  // Una clave de idempotencia por mail: se reutiliza si hay que reintentar, así nunca se duplica.
  const keys = useRef(new Map<string, string>());

  const keyFor = (email: string) => {
    let k = keys.current.get(email);
    if (!k) {
      k = crypto.randomUUID();
      keys.current.set(email, k);
    }
    return k;
  };

  const runCheck = (emails: ExtractedEmail[], pendingUnreadable = unreadable) => {
    setError("");
    setResults(null);
    if (emails.length === 0) {
      setChecked(null);
      if (pendingUnreadable.length === 0) {
        setError("No encontramos ningún mail en el texto. Revisá que estén completos (ej.: nombre@gmail.com).");
      }
      return;
    }
    if (emails.length > MAX_EMAILS_PER_BATCH) {
      setChecked(null);
      setError(`Encontramos ${emails.length} mails. Anotá como máximo ${MAX_EMAILS_PER_BATCH} por vez.`);
      return;
    }
    startTransition(async () => {
      const res = await check(emails.map((e) => e.email));
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setExtracted(emails);
      setChecked(res.items);
      setLeft(res.remaining);
      setSelected(new Set(res.items.filter((i) => i.status === "ok").map((i) => i.email)));
    });
  };

  /** Limpia todo para pegar otra lista sin tener que borrar a mano. */
  const resetAll = () => {
    setText("");
    setChecked(null);
    setExtracted([]);
    setUnreadable([]);
    setIgnored(0);
    setError("");
    setTimeout(() => textRef.current?.focus(), 0);
  };

  const onReview = () => {
    const a = analyzeEmailText(text);
    setUnreadable(a.unreadable);
    setIgnored(a.ignoredLines);
    runCheck(a.emails, a.unreadable);
  };

  const applyUnreadable = (u: UnreadableEmail) => {
    if (!u.suggestion) return;
    const sug = u.suggestion;
    setText((t) => (t.includes(u.text) ? t.split(u.text).join(sug) : `${t}\n${sug}`));
    const rest = unreadable.filter((x) => x.text !== u.text);
    setUnreadable(rest);
    const base = checked ? extracted : [];
    runCheck(base.some((e) => e.email === sug) ? base : [...base, { email: sug }], rest);
  };

  const applySuggestion = (from: string, to: string) => {
    const next = extracted.map((e) => (e.email === from ? { email: to } : e));
    setText((t) => t.split(from).join(to));
    runCheck(next);
  };

  const toAdd = (checked ?? []).filter((i) => i.status === "ok" && selected.has(i.email));
  // "repeated" (el mismo mail dos veces en la lista) no es un problema: se anota una vez.
  const blocked = (checked ?? []).filter((i) => i.status !== "ok" && i.status !== "repeated");
  const tooMany = toAdd.length > left;

  const onSubmit = () => {
    setError("");
    startTransition(async () => {
      try {
        const res = await submit(toAdd.map((i) => ({ email: i.email, idempotencyKey: keyFor(i.email) })));
        if ("error" in res) {
          setError(res.error);
          return;
        }
        for (const r of res.results) if (r.outcome.kind !== "error") keys.current.delete(r.email);
        setResults(res.results);
        setLeft(res.remaining);
        if (res.results.every((r) => r.outcome.kind !== "error")) {
          setText("");
          setChecked(null);
          setExtracted([]);
          setUnreadable([]);
          setIgnored(0);
        }
        router.refresh();
      } catch {
        setError("Se cortó la conexión. Tocá “Anotar” de nuevo: no se va a duplicar nada.");
      }
    });
  };

  const suggestionFor = (email: string) => extracted.find((e) => e.email === email)?.suggestion;

  return (
    <div className="space-y-3">
      <label htmlFor="guest-list" className="block text-sm font-medium text-slate-700">
        Pegá acá el mail o la lista completa que te mandaron (nombre, mail, DNI…). Se toman solo los mails.
      </label>
      <textarea
        ref={textRef}
        id="guest-list"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setChecked(null);
          setUnreadable([]);
        }}
        rows={4}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder={"Juan Pérez - juanperez@gmail.com - 40123456\nAna López ana.lopez@hotmail.com 41222333"}
        className={inputClass}
      />
      {!checked ? (
        <div className="flex gap-2">
          <button type="button" onClick={onReview} disabled={pending || !text.trim()} className={cx(buttonClass, "flex-1 sm:flex-none")}>
            {pending ? "Revisando…" : "Revisar mails"}
          </button>
          {text ? (
            <button type="button" onClick={resetAll} disabled={pending} className={secondaryButtonClass}>
              Borrar
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      {unreadable.length || (checked && ignored) ? (
        <UnreadableBox items={unreadable} ignoredLines={checked ? ignored : 0} onUse={applyUnreadable} />
      ) : null}

      {checked ? (
        <div className="space-y-3 rounded-xl border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-700">
            Encontramos {checked.length} {checked.length === 1 ? "mail" : "mails"}:
          </p>
          <ul className="divide-y divide-slate-100">
            {checked.map((i, idx) => {
              const s = STATUS[i.status];
              const sug = suggestionFor(i.email);
              return (
                <li key={`${i.email}-${idx}`} className="flex flex-wrap items-center gap-2 py-2">
                  {i.status === "ok" ? (
                    <input
                      type="checkbox"
                      aria-label={`Anotar ${i.email}`}
                      className="h-5 w-5 accent-brand-600"
                      checked={selected.has(i.email)}
                      onChange={(e) => {
                        const n = new Set(selected);
                        if (e.target.checked) n.add(i.email);
                        else n.delete(i.email);
                        setSelected(n);
                      }}
                    />
                  ) : (
                    <span className="h-5 w-5" />
                  )}
                  <span className="min-w-0 flex-1 break-all text-sm font-medium">{i.email}</span>
                  <Badge tone={s.tone}>{i.message && i.status === "taken" ? i.message : s.label}</Badge>
                  {sug ? (
                    <div className="flex w-full flex-wrap items-center gap-2 pl-7 text-xs text-amber-800">
                      ¿Quisiste decir <strong className="break-all">{sug}</strong>?
                      <button type="button" className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 font-medium" onClick={() => applySuggestion(i.email, sug)}>
                        Corregir
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {blocked.length ? (
            <Alert tone="warning" title={blocked.length === 1 ? "1 mail no se puede anotar:" : `${blocked.length} mails no se pueden anotar:`}>
              <ul className="mt-1 space-y-0.5">
                {blocked.map((b, idx) => (
                  <li key={`${b.email}-${idx}`} className="break-words">
                    <strong className="break-all">{b.email}</strong>: {b.message && b.status === "taken" ? b.message : BLOCKED_REASON[b.status]}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {tooMany ? (
            <Alert tone="warning">
              Seleccionaste {toAdd.length} pero {who === "vos" ? "te quedan" : `a ${who} le quedan`} {left} {left === 1 ? "entrada" : "entradas"}. Desmarcá {toAdd.length - left}.
            </Alert>
          ) : toAdd.length ? (
            <p className="text-sm text-slate-700">
              {blocked.length ? (
                <>
                  {toAdd.length === 1 ? "El otro está bien." : `Los otros ${toAdd.length} están bien.`} <strong>¿{toAdd.length === 1 ? "Lo anotamos" : "Los anotamos"}?</strong>{" "}
                </>
              ) : (
                <>Se van a anotar <strong>{toAdd.length}</strong>. </>
              )}
              {who === "vos" ? "Te quedarían" : `A ${who} le quedarían`} <strong>{left - toAdd.length}</strong> de {left} entradas disponibles.
            </p>
          ) : (
            <p className="text-sm text-slate-600">No hay mails para anotar en esta lista.</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {toAdd.length === 0 ? (
              <button type="button" onClick={resetAll} disabled={pending} className={buttonClass}>
                Probar con otra lista
              </button>
            ) : (
            <button type="button" onClick={onSubmit} disabled={pending || toAdd.length === 0 || tooMany} className={buttonClass}>
              {pending
                ? "Anotando…"
                : blocked.length && toAdd.length
                  ? `Sí, anotar ${toAdd.length === 1 ? "ese" : `los ${toAdd.length}`}`
                  : `Anotar ${toAdd.length} ${toAdd.length === 1 ? "entrada" : "entradas"}`}
            </button>
            )}
            <button type="button" onClick={() => setChecked(null)} disabled={pending} className={secondaryButtonClass}>
              Editar la lista
            </button>
            {toAdd.length > 0 ? (
              <button type="button" onClick={resetAll} disabled={pending} className={secondaryButtonClass}>
                Probar con otra lista
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {results ? (
        <div aria-live="polite" className="space-y-2">
          {results.some((r) => r.outcome.kind === "created") ? (
            <Alert tone={results.every((r) => r.outcome.kind === "created" && r.outcome.sync === "synced") ? "success" : "warning"} title="Listo">
              Se anotaron {results.filter((r) => r.outcome.kind === "created").length}.{" "}
              {who === "vos" ? "Te quedan" : `A ${who} le quedan`} {left} {left === 1 ? "entrada" : "entradas"}.
              {results.some((r) => r.outcome.kind === "created" && r.outcome.sync === "pending")
                ? " Algunas filas se van a pasar a la planilla en unos minutos (ya están guardadas)."
                : ""}
            </Alert>
          ) : null}
          {results.some((r) => r.outcome.kind !== "created") ? (
            <Alert tone="error" title="Atención: estos mails NO se anotaron">
              <ul className="mt-1 space-y-0.5">
                {results
                  .filter((r) => r.outcome.kind !== "created")
                  .map((r) => (
                    <li key={r.email} className="break-words">
                      <strong className="break-all">{r.email}</strong>: {outcomeText(r).text.replace(/: no se anotó$/, "").toLowerCase()}
                    </li>
                  ))}
              </ul>
              {results.some((r) => r.outcome.kind === "created") ? <p className="mt-1">Los demás quedaron anotados.</p> : null}
            </Alert>
          ) : null}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-3">
            {results.map((r) => {
              const t = outcomeText(r);
              return (
                <li key={r.email} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="break-all font-medium">{r.email}</span>
                  <Badge tone={t.tone}>{t.text}</Badge>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
