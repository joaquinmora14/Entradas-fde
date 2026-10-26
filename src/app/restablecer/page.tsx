import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { ResetPasswordForm } from "@/components/auth-forms";
import { Alert, TextLink } from "@/components/ui";

export const metadata: Metadata = { title: "Nueva contraseña", referrer: "no-referrer" };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthShell
      title="Nueva contraseña"
      subtitle="Elegí la contraseña con la que vas a ingresar."
      footer={
        <p>
          <TextLink href="/login">Volver a ingresar</TextLink>
        </p>
      }
    >
      {token ? <ResetPasswordForm token={token} /> : <Alert tone="error">El enlace está incompleto. Pedí uno nuevo.</Alert>}
    </AuthShell>
  );
}
