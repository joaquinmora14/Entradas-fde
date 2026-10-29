import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { RequestResetForm } from "@/components/auth-forms";
import { TextLink } from "@/components/ui";

export const metadata: Metadata = { title: "Recuperar acceso" };

export default function RecoverPage() {
  return (
    <AuthShell
      title="Olvidé mi contraseña"
      subtitle="Poné tu mail y te mandamos un link para elegir una contraseña nueva."
      footer={
        <p>
          <TextLink href="/login">Volver a ingresar</TextLink>
        </p>
      }
    >
      <RequestResetForm />
    </AuthShell>
  );
}
