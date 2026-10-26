import { redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/session";

export default async function Home() {
  const actor = await getCurrentActor();
  if (!actor) redirect("/login");
  redirect(actor.isGraduate ? "/panel" : "/admin");
}
