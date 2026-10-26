import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { RegisterForm } from "@/components/auth-forms";
import { TextLink } from "@/components/ui";
import { getCurrentActor } from "@/lib/session";
import { getRegistrationCodeHash } from "@/server/auth";

export const metadata: Metadata = { title: "Crear cuenta" };

export default async function RegisterPage() {
  if (await getCurrentActor()) redirect("/");
  const needsCode = Boolean(await getRegistrationCodeHash());
  return (
    <AuthShell
      title="Crear cuenta"
      subtitle="Solo pueden registrarse los egresados habilitados por la organización."
      footer={
        <p>
          ¿Ya tenés cuenta? <TextLink href="/login">Ingresá</TextLink>
        </p>
      }
    >
      <RegisterForm needsCode={needsCode} />
    </AuthShell>
  );
}
