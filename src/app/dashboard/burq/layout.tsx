import { requireUser, homePathFor } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";

/**
 * Настройки Burq доступны ЛЮБОМУ аутентифицированному пользователю админки (requireUser,
 * НЕ OWNER-only). Отдельный сегмент вне role-групп, чтобы страницу мог открыть любой роль.
 */
export default async function BurqLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav: NavItem[] = [
    { href: homePathFor(user.role), label: "← Дашборд" },
    { href: "/dashboard/burq", label: "Burq" },
  ];
  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
