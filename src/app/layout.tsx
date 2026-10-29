import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { getCurrentActor, getOtherActor } from "@/lib/session";
import { logoutAction, switchAccountAction } from "@/app/actions/auth";
import { InAppBrowserNotice } from "@/components/in-app-browser-notice";
import { NavLinks } from "@/components/nav-links";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Invitaciones · Fiesta de Egresados", template: "%s · Fiesta de Egresados" },
  description: "Registro de invitados para la fiesta de egresados.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#4f46e5",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const actor = await getCurrentActor();
  const other = actor ? await getOtherActor() : null;
  const otherName = other ? (other.displayName ?? other.email) : null;
  const links = actor
    ? [
        ...(actor.isGraduate
          ? [
              { href: "/panel", label: "Mis entradas" },
              { href: "/pool", label: "Fuera de lista" },
            ]
          : []),
        { href: "/cupos", label: "Cupos" },
        ...(actor.isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
      ]
    : [
        { href: "/cupos", label: "Cupos" },
        { href: "/login", label: "Ingresar" },
      ];
  return (
    <html lang="es">
      <body className="min-h-dvh font-sans antialiased">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
            <Link href={actor ? (actor.isGraduate ? "/panel" : "/admin") : "/"} className="flex items-center gap-2 font-bold text-slate-900">
              <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">🎓</span>
              <span className="hidden sm:inline">Fiesta de Egresados</span>
            </Link>
            <div className="flex items-center gap-1">
              <NavLinks links={links} />
              {actor ? (
                <form action={logoutAction}>
                  <button className="rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100" type="submit">
                    Salir
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </header>
        {other && other.id !== actor?.id ? (
          <div className="border-b border-brand-100 bg-brand-50">
            <form action={switchAccountAction} className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm text-brand-700">
              <span>
                Estás como <strong>{actor?.displayName ?? actor?.email}</strong>.
              </span>
              <button type="submit" className="rounded-lg bg-white px-3 py-1.5 font-semibold text-brand-700 shadow-sm ring-1 ring-brand-100 hover:bg-brand-100">
                Cambiar a {otherName}
              </button>
            </form>
          </div>
        ) : null}
        <main className="mx-auto max-w-5xl px-4 py-6 sm:py-8">
          <InAppBrowserNotice />
          {children}
        </main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-center text-xs text-slate-400">
          {actor ? (
            <>
              Sesión: {actor.displayName ?? actor.email}
              {!other ? (
                <form action={switchAccountAction} className="mt-1">
                  <button type="submit" className="font-medium text-brand-700 underline-offset-2 hover:underline">
                    Entrar con otra cuenta (sin cerrar esta)
                  </button>
                </form>
              ) : null}
            </>
          ) : (
            "Invitaciones para la fiesta de egresados"
          )}
        </footer>
      </body>
    </html>
  );
}
