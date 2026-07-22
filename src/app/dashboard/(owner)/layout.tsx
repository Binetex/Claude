import { requireRole } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";

const nav: NavItem[] = [
  { href: "/dashboard", label: "Дашборд" },
  { href: "/dashboard/orders", label: "Заказы" },
  { href: "/dashboard/print-cards", label: "Печать открыток" },
  { href: "/dashboard/sites", label: "Сайты" },
  { href: "/dashboard/products", label: "Товары" },
  { href: "/dashboard/florists", label: "Флористы" },
  { href: "/dashboard/burq", label: "Доставка (Burq)" },
  { href: "/dashboard/automations", label: "Автоматизации" },
  { href: "/dashboard/settings/telegram", label: "Telegram" },
  { href: "/dashboard/users", label: "Пользователи" },
];

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("OWNER");
  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
