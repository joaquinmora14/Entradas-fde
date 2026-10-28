"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { analyzeEmailText, type ExtractedEmail, type UnreadableEmail } from "@/lib/extract-emails";
import type { PoolCheckItem, PoolCheckStatus, PoolImportReport } from "@/server/pool-admin";
import { UnreadableBox } from "./unreadable-box";
import { Alert, Badge, buttonClass, cx, inputClass, secondaryButtonClass } from "./ui";

const STATUS: Record<PoolCheckStatus, { label: string; tone: "green" | "amber" | "red" | "slate" }> = {
  ok: { label: "Se puede agregar", tone: "green" },
  invalid: { label: "Mail inválido", tone: "red" },
  repeated: { label: "Repetido en la lista", tone: "slate" },
  in_pool: { label: "Ya está en la lista", tone: "slate" },
  has_entry: { label: "Ya tiene entrada", tone: "red" },
  graduate: { label: "Es egresado", tone: "slate" },
};

type CheckResult = { items: PoolCheckItem[] } | { error: string };
type AddResult = { report: PoolImportReport } | { error: string };

/** Sumar gente a "fuera de lista": pegar la lista, revisar y confirmar (igual que anotar entradas). */
export function PoolAddForm({
  check,
  add,
}: {
  check: (emails: string[]) => Promise<CheckResult>;
  add: (emails: string[]) => Promise<AddResult>;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [extracted, setExtracted] = useState<ExtractedEmail[]>([]);
  const [checked, setChecked] = useState<PoolCheckItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unreadable, setUnreadable] = useState<UnreadableEmail[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const runCheck = (emails: ExtractedEmail[], pendingUnreadable: UnreadableEmail[]) => {
    setError("");
    setDone(null);
    if (emails.length === 0) {
      setChecked(null);
      if (pendingUnreadable.length === 0) setError("No encontramos ningún mail en el texto.");
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
    setText((t) => t.split(from).join(to));
    runCheck(extracted.map((e) => (e.email === from ? { email: to } : e)), unreadable);
  };

  const toAdd = (checked ?? []).filter((i) => i.status === "ok" && selected.has(i.email));
  const blocked = (checked ?? []).filter((i) => i.status !== "ok" && i.status !== "repeated");

  const onAdd = () => {
    setError("");
    startTransition(async () => {
      const res = await add(toAdd.map((i) => i.email));
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const r = res.report;
      const extra = r.duplicates.length + r.conflicts.length + r.invalid.length;
      setDone(
        `Se ${r.added.length === 1 ? "agregó 1 persona" : `agregaron ${r.added.length} personas`} a la lista.` +
          (extra ? ` ${extra} no se agregaron porque cambiaron mientras revisabas (ya estaban o ya tienen entrada).` : ""),
      );
      setText("");
      setChecked(null);
      setExtracted([]);
      setUnreadable([]);
      setIgnored(0);
      router.refresh();
    });
  };

  const suggestionFor = (email: string) => extracted.find((e) => e.email === email)?.suggestion;

  return (
    <div className="space-y-3">
      <textarea
        ref={textRef}
        aria-label="Lista de personas"
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
        placeholder={"Juan Pérez - juan@gmail.com - 40123456\nAna López, ana@hotmail.com, 41222333"}
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
      {done ? <Alert tone="success">{done}</Alert> : null}
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
                      aria-label={`Agregar ${i.email}`}
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
                  <Badge tone={s.tone}>{i.message ?? s.label}</Badge>
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
            <Alert tone="warning" title={blocked.length === 1 ? "1 mail no se puede agregar:" : `${blocked.length} mails no se pueden agregar:`}>
              <ul className="mt-1 space-y-0.5">
                {blocked.map((b, idx) => (
                  <li key={`${b.email}-${idx}`} className="break-words">
                    <strong className="break-all">{b.email}</strong>: {b.message ?? STATUS[b.status].label.toLowerCase()}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {toAdd.length ? (
            <p className="text-sm text-slate-700">
              {blocked.length ? (
                <>
                  {toAdd.length === 1 ? "El otro está bien." : `Los otros ${toAdd.length} están bien.`} <strong>¿{toAdd.length === 1 ? "Lo agregamos" : "Los agregamos"}?</strong>
                </>
              ) : (
                <>Se van a agregar <strong>{toAdd.length}</strong> a la lista.</>
              )}
            </p>
          ) : (
            <p className="text-sm text-slate-600">No hay mails nuevos para agregar en esta lista.</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            {toAdd.length === 0 ? (
              <button type="button" onClick={resetAll} disabled={pending} className={buttonClass}>
                Probar con otra lista
              </button>
            ) : (
            <button type="button" onClick={onAdd} disabled={pending || toAdd.length === 0} className={buttonClass}>
              {pending
                ? "Agregando…"
                : blocked.length && toAdd.length
                  ? `Sí, agregar ${toAdd.length === 1 ? "ese" : `los ${toAdd.length}`}`
                  : `Agregar ${toAdd.length} a la lista`}
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
    </div>
  );
}
