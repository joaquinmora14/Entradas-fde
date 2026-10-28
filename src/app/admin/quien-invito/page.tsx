import type { Metadata } from "next";
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
        subtitle="Cada egresado con los mails a los que les dio entrada, agrupados como los anotó. Tocá el nombre para corregir o anular."
      />
      <InvitesByGraduate graduates={graduates} />
    </div>
  );
}
