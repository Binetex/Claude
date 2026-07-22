import { requireRole } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";

const nav: NavItem[] = [{ href: "/dashboard/cc", label: "Заказы" }];

export default async function CallCenterLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("CALL_CENTER");
  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
