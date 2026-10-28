import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { RegisterForm } from "@/components/auth-forms";
import { TextLink } from "@/components/ui";
import { getCurrentActor } from "@/lib/session";
import { getRegistrationCodeHash } from "@/server/auth";

export const metadata: Metadata = { title: "Crear cuenta" };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  if (await getCurrentActor()) redirect("/");
  const { email } = await searchParams;
  const needsCode = Boolean(await getRegistrationCodeHash());
  return (
    <AuthShell
      title="Crear tu cuenta"
      subtitle="Es una sola vez: poné el mail que le diste a Juli y elegí una contraseña. Después entrás directo."
      footer={
        <p>
          ¿Ya creaste tu cuenta? <TextLink href="/login">Ingresá</TextLink>
        </p>
      }
    >
      <RegisterForm needsCode={needsCode} email={typeof email === "string" ? email.slice(0, 254) : undefined} />
    </AuthShell>
  );
}
