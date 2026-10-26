"use client";

import { useActionState, useRef, type ReactNode } from "react";
import type { FormState } from "@/lib/form-state";
import { initialFormState } from "@/lib/form-state";
import { Alert, cx } from "./ui";
import { ImportReportView } from "./import-report";
import { DiagnosisView } from "./diagnosis-view";

/**
 * Formulario genérico para acciones administrativas: muestra el resultado
 * y, si la acción devuelve un enlace, lo presenta para copiarlo.
 */
export function ActionForm({
  action,
  hidden,
  children,
  confirm,
  className,
  view,
  resetOnSuccess,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  hidden?: Record<string, string>;
  children: ReactNode;
  confirm?: string;
  className?: string;
  view?: "import-report" | "diagnosis";
  resetOnSuccess?: boolean;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [state, formAction] = useActionState(async (prev: FormState, form: FormData) => {
    const result = await action(prev, form);
    if (result.ok && resetOnSuccess) ref.current?.reset();
    return result;
  }, initialFormState);
  const link = (state.data as { link?: string } | undefined)?.link;
  return (
    <form
      ref={ref}
      action={formAction}
      className={cx("space-y-2", className)}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      {children}
      {state.message ? <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert> : null}
      {link ? (
        <div className="flex gap-2">
          <input readOnly value={link} className="w-full rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="rounded-lg border border-slate-300 px-2 text-xs" onClick={() => navigator.clipboard?.writeText(link)}>
            Copiar
          </button>
        </div>
      ) : null}
      {state.data && view === "import-report" ? <ImportReportView report={state.data} /> : null}
      {state.data && view === "diagnosis" ? <DiagnosisView diag={state.data} /> : null}
    </form>
  );
}
