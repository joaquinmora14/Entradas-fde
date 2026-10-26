import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Field, PageTitle, inputClass, secondaryButtonClass } from "@/components/ui";
import { settingsAction } from "@/app/actions/admin";
import { getCurrentActor } from "@/lib/session";
import { getSettings } from "@/server/admin";

export const metadata: Metadata = { title: "Ajustes" };

export default async function SettingsPage() {
  const s = await getSettings(await getCurrentActor());
  return (
    <div className="space-y-5">
      <PageTitle title="Ajustes" />
      <Card>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Código de registro</h2>
          <Badge tone={s.registrationCodeEnabled ? "green" : "slate"}>{s.registrationCodeEnabled ? "Activado" : "Desactivado"}</Badge>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Opcional. Si lo activás, además de estar en la lista autorizada, cada egresado tiene que ingresar este código al crear su cuenta
          (compartilo por el grupo de egresados). Evita que alguien de afuera que conozca un email autorizado cree la cuenta.
        </p>
        <ActionForm action={settingsAction} className="mt-3" hidden={{ op: "set" }} resetOnSuccess>
          <Field label="Nuevo código" htmlFor="registrationCode">
            <input id="registrationCode" name="registrationCode" required minLength={4} autoComplete="off" className={inputClass} />
          </Field>
          <SubmitButton>Guardar código</SubmitButton>
        </ActionForm>
        {s.registrationCodeEnabled ? (
          <ActionForm action={settingsAction} className="mt-3" hidden={{ op: "clear" }}>
            <SubmitButton className={secondaryButtonClass}>Desactivar código</SubmitButton>
          </ActionForm>
        ) : null}
      </Card>
    </div>
  );
}
