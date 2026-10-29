"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { analyzeEmailText, MAX_EMAILS_PER_BATCH, type ExtractedEmail, type UnreadableEmail } from "@/lib/extract-emails";
import { UnreadableBox } from "./unreadable-box";
import type { CheckedEmail, CheckStatus, GroupOutcome } from "@/server/invitations";
import { Alert, Badge, SendWarning, buttonClass, cx, inputClass, secondaryButtonClass } from "./ui";
import { CopyButton } from "./copy-button";
import { RegretInfo } from "./regret-info";

type CheckResult = { items: CheckedEmail[]; remaining: number } | { error: string };

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

export function BulkInviteForm({
  check,
  submit,
  remaining,
  who = "vos",
}: {
  check: (emails: string[]) => Promise<CheckResult>;
  submit: (emails: string[], idempotencyKey: string) => Promise<GroupOutcome>;
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
  const [done, setDone] = useState<Extract<GroupOutcome, { kind: "created" }> | null>(null);
  const [notice, setNotice] = useState("");
  const [unreadable, setUnreadable] = useState<UnreadableEmail[]>([]);
  const [ignored, setIgnored] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  // Una clave de idempotencia por grupo (el mismo conjunto de mails): se reutiliza si hay que
  // reintentar, así nunca se duplica ni se descuenta de más.
  const keys = useRef(new Map<string, string>());

  const keyFor = (emails: string[]) => {
    const id = [...emails].sort().join("\n");
    let k = keys.current.get(id);
    if (!k) {
      k = crypto.randomUUID();
      keys.current.set(id, k);
    }
    return { id, key: k };
  };

  const runCheck = (emails: ExtractedEmail[], pendingUnreadable = unreadable, keepNotice = false) => {
    setError("");
    setDone(null);
    if (!keepNotice) setNotice("");
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
    setNotice("");
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

  // Todos los mails de la lista son un grupo que va junto: se anotan todos o ninguno.
  const toAdd = (checked ?? []).filter((i) => i.status === "ok");
  // "repeated" (el mismo mail dos veces en la lista) no es un problema: se anota una vez.
  const blocked = (checked ?? []).filter((i) => i.status !== "ok" && i.status !== "repeated");
  const tooMany = toAdd.length > left;
  const entradas = (n: number) => `${n} ${n === 1 ? "entrada" : "entradas"}`;
  const quedan = who === "vos" ? (left === 1 ? "te queda" : "te quedan") : `a ${who} le ${left === 1 ? "queda" : "quedan"}`;

  const onSubmit = () => {
    setError("");
    setNotice("");
    const emails = toAdd.map((i) => i.email);
    const { id, key } = keyFor(emails);
    startTransition(async () => {
      try {
        const res = await submit(emails, key);
        if (res.kind !== "error") keys.current.delete(id);
        if (res.kind === "created") {
          setDone(res);
          setLeft(res.remaining);
          setText("");
          setChecked(null);
          setExtracted([]);
          setUnreadable([]);
          setIgnored(0);
          router.refresh();
        } else if (res.kind === "conflict") {
          // Algo cambió mientras se revisaba: no se anotó a nadie. Se vuelve a revisar la lista.
          setNotice(
            `Mientras revisabas, ${res.blocked.map((b) => b.email).join(", ")} ${res.blocked.length === 1 ? "pasó a tener" : "pasaron a tener"} entrada. No se anotó a nadie del grupo: revisá la lista de nuevo.`,
          );
          runCheck(extracted, unreadable, true);
        } else if (res.kind === "quota_exhausted") {
          setLeft(res.remaining);
          setError(
            `El grupo es de ${res.needed} y ${who === "vos" ? (res.remaining === 1 ? "te queda" : "te quedan") : `a ${who} le ${res.remaining === 1 ? "queda" : "quedan"}`} ${entradas(res.remaining)}. Van juntos: no se anotó a nadie.`,
          );
        } else {
          setError(res.message);
        }
      } catch {
        setError("Se cortó la conexión. Tocá “Anotar” de nuevo: no se va a duplicar nada.");
      }
    });
  };

  const suggestionFor = (email: string) => extracted.find((e) => e.email === email)?.suggestion;

  return (
    <div className="space-y-3">
      <SendWarning who={who} />
      <label htmlFor="guest-list" className="block text-sm font-medium text-slate-700">
        Pegá acá el mensaje que te mandaron (nombre, mail, DNI…). Se toman solo los mails. Las personas de un mismo
        mensaje van juntas: se anotan todas como un grupo. Pegá un grupo por vez.
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
      {notice ? <Alert tone="warning">{notice}</Alert> : null}
      {unreadable.length || (checked && ignored) ? (
        <UnreadableBox items={unreadable} ignoredLines={checked ? ignored : 0} onUse={applyUnreadable} />
      ) : null}

      {checked ? (
        <div className="space-y-3 rounded-xl border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-700">
            Encontramos {checked.length} {checked.length === 1 ? "mail" : "mails"}
            {toAdd.length > 1 ? <> · <strong>van juntos: se anotan todos como un grupo</strong></> : null}:
          </p>
          <ul className="divide-y divide-slate-100">
            {checked.map((i, idx) => {
              const s = STATUS[i.status];
              const sug = suggestionFor(i.email);
              return (
                <li key={`${i.email}-${idx}`} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 break-all text-sm font-medium">{i.email}</span>
                  <Badge tone={s.tone}>{i.message && i.status === "taken" ? i.message : s.label}</Badge>
                  {sug ? (
                    <div className="flex w-full flex-wrap items-center gap-2 text-xs text-amber-800">
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
            <Alert tone="error" title="No alcanzan las entradas para todo el grupo">
              El grupo es de {toAdd.length} y {quedan} {entradas(left)}. Van juntos: no se puede anotar solo a una parte.
            </Alert>
          ) : toAdd.length ? (
            <p className="text-sm text-slate-700">
              {blocked.length ? (
                <>
                  {toAdd.length === 1 ? "El otro está bien." : `Los otros ${toAdd.length} están bien.`} <strong>¿{toAdd.length === 1 ? "Lo anotamos" : "Los anotamos juntos"}?</strong>{" "}
                </>
              ) : (
                <>Se {toAdd.length === 1 ? "va" : "van"} a anotar <strong>{toAdd.length}</strong>{toAdd.length > 1 ? " juntos" : ""}. </>
              )}
              {who === "vos" ? "Te quedarían" : `A ${who} le quedarían`} <strong>{left - toAdd.length}</strong> de {left} entradas disponibles.
            </p>
          ) : (
            <p className="text-sm text-slate-600">No hay mails para anotar en esta lista.</p>
          )}
          {toAdd.length > 0 && !tooMany ? <SendWarning variant="inline" who={who} /> : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            {toAdd.length === 0 || tooMany ? (
              <button type="button" onClick={resetAll} disabled={pending} className={buttonClass}>
                Probar con otra lista
              </button>
            ) : (
              <button type="button" onClick={onSubmit} disabled={pending} className={buttonClass}>
                {pending
                  ? "Anotando…"
                  : blocked.length
                    ? `Sí, anotar ${toAdd.length === 1 ? "ese" : `los ${toAdd.length} juntos`}`
                    : toAdd.length === 1
                      ? "Anotar 1 entrada"
                      : `Anotar el grupo (${toAdd.length} entradas)`}
              </button>
            )}
            <button type="button" onClick={() => setChecked(null)} disabled={pending} className={secondaryButtonClass}>
              Editar la lista
            </button>
            {toAdd.length > 0 && !tooMany ? (
              <button type="button" onClick={resetAll} disabled={pending} className={secondaryButtonClass}>
                Probar con otra lista
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {done ? (
        <div aria-live="polite" className="space-y-2">
          <Alert tone={done.sync === "synced" ? "success" : "warning"} title="Listo">
            {done.emails.length === 1 ? "Se anotó 1 entrada" : `Se anotó el grupo de ${done.emails.length}`}.{" "}
            {who === "vos" ? (done.remaining === 1 ? "Te queda" : "Te quedan") : `A ${who} le ${done.remaining === 1 ? "queda" : "quedan"}`} {entradas(done.remaining)}.
            {done.sync === "pending" ? " Se va a pasar a la planilla en unos minutos (ya está guardado)." : ""}
          </Alert>
          <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4">
            <p className="text-base font-extrabold text-amber-950">
              ⚠️ Ahora {who === "vos" ? "mandales VOS" : `${who} tiene que mandarles`} la invitación a {done.emails.length === 1 ? "este mail" : "estos mails"}:
            </p>
            <ul className="mt-2 space-y-1.5">
              {done.emails.map((e) => (
                <li key={e} className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2">
                  <span className="min-w-0 flex-1 select-all break-all font-semibold text-slate-900">{e}</span>
                  <CopyButton text={e} />
                </li>
              ))}
            </ul>
            {who === "vos" ? <RegretInfo emails={done.emails} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
