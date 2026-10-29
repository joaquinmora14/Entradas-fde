import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import { TextLink } from "@/components/ui";
import { getCurrentActor, getOtherActor } from "@/lib/session";
import { switchAccountAction } from "@/app/actions/auth";

export const metadata: Metadata = { title: "Ingresar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; email?: string; otra?: string }> }) {
  if (await getCurrentActor()) redirect("/");
  const { next, email } = await searchParams;
  // La cuenta que quedó guardada al tocar "Entrar con otra cuenta".
  const saved = await getOtherActor();
  return (
    <AuthShell
      title="Invitaciones de la fiesta"
      subtitle="Ingresá con tu mail y tu contraseña."
      footer={
        <>
          <p>
            <TextLink href="/recuperar">Olvidé mi contraseña</TextLink> · <TextLink href="/cupos">Ver cupos</TextLink>
          </p>
        </>
      }
    >
      {saved ? (
        <form action={switchAccountAction} className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            Tu cuenta de <strong>{saved.displayName ?? saved.email}</strong> queda guardada. Ingresá con la otra y después cambiás entre las dos
            con un toque.
          </p>
          <button type="submit" className="mt-2 font-semibold text-brand-700 hover:underline">
            ← Volver a {saved.displayName ?? saved.email}
          </button>
        </form>
      ) : null}
      <Link
        href="/registro"
        className="mb-5 block rounded-xl border-2 border-brand-500 bg-brand-50 px-4 py-3 text-center text-brand-700 hover:bg-brand-100"
      >
        <span className="block font-bold">¿Es tu primera vez? Creá tu cuenta →</span>
        <span className="block text-sm">Con el mail que le diste a Juli. Es una sola vez.</span>
      </Link>
      <LoginForm next={next} email={typeof email === "string" ? email.slice(0, 254) : undefined} />
    </AuthShell>
  );
}
