import { NavLinks } from "@/components/nav-links";
import { requireAdminPage } from "@/lib/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  return (
    <div className="space-y-5">
      <div className="-mx-4 overflow-x-auto px-4">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          <NavLinks
            links={[
              { href: "/admin", label: "Resumen" },
              { href: "/admin/egresados", label: "Egresados" },
              { href: "/admin/quien-invito", label: "Quién invitó" },
              { href: "/admin/invitaciones", label: "Invitaciones" },
              { href: "/admin/pool", label: "Pool" },
              { href: "/admin/sincronizacion", label: "Planilla" },
              { href: "/admin/auditoria", label: "Auditoría" },
              { href: "/admin/ajustes", label: "Ajustes" },
            ]}
          />
        </div>
      </div>
      {children}
    </div>
  );
}
