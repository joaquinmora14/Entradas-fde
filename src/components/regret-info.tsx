import { ADMIN_CONTACT_EMAIL } from "@/lib/contact";
import { CopyButton } from "./copy-button";

/**
 * "¿Te arrepentiste?": los mails anotados no se pueden borrar desde el panel del egresado.
 * Se le explica que le avise al administrador, que los borra y le devuelve la entrada.
 */
export function RegretInfo({ emails }: { emails: string[] }) {
  const subject = "Borrar invitación - Fiesta de egresados";
  const body = `Hola, me arrepentí de ${emails.length === 1 ? "este mail y quiero que lo borres" : "estos mails y quiero que los borres"}:\n\n${emails.join("\n")}\n\nGracias.`;
  const mailto = `mailto:${ADMIN_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <details className="group mt-2 rounded-xl border border-sky-200 bg-sky-50 text-sm text-sky-950">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-semibold [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">i</span>
        ¿Te arrepentiste?
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p>
          Desde acá no se puede borrar un mail anotado. Avisale al administrador, <strong className="break-all">{ADMIN_CONTACT_EMAIL}</strong>,
          diciéndole qué {emails.length === 1 ? "mail" : "mails"} querés borrar. Él lo borra y la entrada vuelve a estar disponible para vos.
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href={mailto}
            className="inline-flex items-center rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white no-underline hover:bg-sky-700"
          >
            Escribirle un mail
          </a>
          <CopyButton text={ADMIN_CONTACT_EMAIL} label="Copiar su mail" className="px-3 py-2 text-sm" />
        </div>
      </div>
    </details>
  );
}
