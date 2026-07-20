import { requireUser, homePathFor } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";

/**
 * Раздел «Нераспознанные коммуникации» — ЛЮБОМУ аутентифицированному сотруднику (requireUser,
 * НЕ OWNER-only). Отдельный сегмент вне role-групп, чтобы страницу мог открыть любой роль.
 */
export default async function CommunicationsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav: NavItem[] = [
    { href: homePathFor(user.role), label: "← Дашборд" },
    { href: "/dashboard/communications", label: "Нераспознанные" },
  ];
  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
