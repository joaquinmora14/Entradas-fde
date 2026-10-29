import type { Metadata } from "next";
import { deleteInvitationAction } from "@/app/actions/admin";
import { InvitesByGraduate } from "@/components/invites-by-graduate";
import { PageTitle } from "@/components/ui";
import { getCurrentActor } from "@/lib/session";
import { listInvitesByGraduate } from "@/server/admin";

export const metadata: Metadata = { title: "Quién invitó a quién" };

export default async function WhoInvitedPage() {
  const graduates = await listInvitesByGraduate(await getCurrentActor());
  return (
    <div className="space-y-5">
      <PageTitle
        title="Quién invitó a quién"
        subtitle="Cada egresado con los mails a los que les dio entrada, agrupados como los anotó. Si alguien se arrepintió, tocá “Borrar” (un mail) o “Borrar grupo”: la entrada vuelve al egresado y se quita de la planilla."
      />
      <InvitesByGraduate graduates={graduates} remove={deleteInvitationAction} />
    </div>
  );
}
