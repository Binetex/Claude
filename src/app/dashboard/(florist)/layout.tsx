import { requireFlorist } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";

const nav: NavItem[] = [{ href: "/dashboard/f", label: "Мои заказы" }];

export default async function FloristLayout({ children }: { children: React.ReactNode }) {
  const user = await requireFlorist();
  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
