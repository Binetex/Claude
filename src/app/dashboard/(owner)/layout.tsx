import { requireRole } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";

const nav: NavItem[] = [
  { href: "/dashboard/orders", label: "Заказы" },
  { href: "/dashboard/sites", label: "Сайты" },
  { href: "/dashboard/products", label: "Товары" },
  { href: "/dashboard/florists", label: "Флористы" },
  // Один пункт на весь раздел: подстраницы живут во вкладках внутри (finance/layout.tsx).
  // Пять финансовых пунктов вперемешку с заказами и товарами топят и то и другое.
  { href: "/dashboard/finance", label: "Финансы" },
  // Отдельно от «Финансов»: там расчёты с флористами, здесь — расходы самого бизнеса.
  { href: "/dashboard/expenses", label: "Мои расходы" },
  { href: "/dashboard/burq", label: "Доставка (Burq)" },
  { href: "/dashboard/automations", label: "Автоматизации" },
  { href: "/dashboard/reviews", label: "Отзывы" },
  { href: "/dashboard/settings/telegram", label: "Telegram" },
  { href: "/dashboard/settings/print", label: "Печать записок" },
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
