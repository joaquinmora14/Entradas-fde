import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6", className)}>
      {children}
    </section>
  );
}

export function PageTitle({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

type Tone = "success" | "warning" | "error" | "info";
const toneClass: Record<Tone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
};
const toneIcon: Record<Tone, string> = { success: "✓", warning: "!", error: "✕", info: "i" };

export function Alert({ tone, title, children }: { tone: Tone; title?: string; children?: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl border p-3.5 text-sm", toneClass[tone])}>
      <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/70 text-xs font-bold">
        {toneIcon[tone]}
      </span>
      <div className="min-w-0 break-words">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
      </div>
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div
        className="h-3 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <div
          className={cx("h-full rounded-full transition-all", pct >= 100 ? "bg-rose-500" : pct >= 75 ? "bg-amber-500" : "bg-brand-600")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "green" | "amber" | "red" | "brand" | "sky" }) {
  const t = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-rose-100 text-rose-800",
    brand: "bg-brand-100 text-brand-700",
    sky: "bg-sky-100 text-sky-800",
  }[tone];
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", t)}>{children}</span>;
}

export function SyncBadge({ sync }: { sync: "synced" | "pending" | "error" }) {
  if (sync === "synced") return <Badge tone="green">En la planilla</Badge>;
  return <Badge tone="amber">Sincronización pendiente</Badge>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children ? <div className="mt-1 text-sm text-slate-500">{children}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "brand" | "plain" }) {
  return (
    <div className={cx("rounded-xl border p-4", tone === "brand" ? "border-brand-100 bg-brand-50" : "border-slate-200 bg-white")}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx("mt-1 text-2xl font-bold tabular-nums", tone === "brand" ? "text-brand-700" : "text-slate-900")}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export const inputClass =
  "block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100 disabled:bg-slate-50";

export const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

export const dangerButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60";

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-brand-700 underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(iso));
}

/**
 * Aviso obligatorio: la app NO envía nada. El egresado tiene que mandarle la invitación
 * a cada mail que anota. Se muestra en cada paso donde se anota a alguien.
 */
export function SendWarning({ variant = "big", who = "vos" }: { variant?: "big" | "inline"; who?: string }) {
  const sujeto = who === "vos" ? "vos" : who;
  if (variant === "inline") {
    return (
      <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-bold text-amber-950">
        ⚠️ Recordá: al anotar no se le manda nada a nadie. Después {who === "vos" ? "tenés" : "tiene"} que mandarle la invitación a cada uno.
      </p>
    );
  }
  return (
    <div role="note" className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-amber-950">
      <p className="text-base font-extrabold uppercase tracking-wide">⚠️ Importante</p>
      <p className="mt-1 text-lg font-bold leading-snug">
        La app NO le manda nada a nadie. Si anotás un mail, después {sujeto === "vos" ? "tenés que mandarle VOS" : `${sujeto} tiene que mandarle`} la invitación a esa persona.
      </p>
      <p className="mt-1 text-sm">Anotar solo reserva el lugar y evita que otro egresado use el mismo mail.</p>
    </div>
  );
}
