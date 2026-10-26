import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "@/components/auth-forms";
import { TextLink } from "@/components/ui";
import { getCurrentActor } from "@/lib/session";

export const metadata: Metadata = { title: "Ingresar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentActor()) redirect("/");
  const { next } = await searchParams;
  return (
    <AuthShell
      title="Invitaciones de la fiesta"
      subtitle="Ingresá para registrar a tus invitados."
      footer={
        <>
          <p>
            ¿Primera vez? <TextLink href="/registro">Creá tu cuenta</TextLink>
          </p>
          <p>
            <TextLink href="/recuperar">Olvidé mi contraseña</TextLink> · <TextLink href="/cupos">Ver cupos</TextLink>
          </p>
        </>
      }
    >
      <LoginForm next={next} />
    </AuthShell>
  );
}
