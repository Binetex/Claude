import { requireFlorist } from "@/lib/rbac";
import { AppShell, type NavItem } from "@/components/AppShell";
import { prisma } from "@/lib/db";

const baseNav: NavItem[] = [
  { href: "/dashboard/f", label: "Мои заказы" },
  { href: "/dashboard/f/finance", label: "Мои финансы" },
];

export default async function FloristLayout({ children }: { children: React.ReactNode }) {
  const user = await requireFlorist();

  // Пункт «Расходы на цветы» появляется только у основного флориста: дневная закупка
  // существует лишь у PRIMARY-профиля, и показывать остальным пункт, ведущий в отказ, —
  // значит обещать раздел, которого у них нет.
  const primary = await prisma.floristFinanceProfile.findFirst({
    where: { floristId: user.floristId, model: "PRIMARY", active: true, effectiveTo: null },
    select: { id: true },
  });

  const nav: NavItem[] = [
    ...baseNav,
    ...(primary ? [{ href: "/dashboard/f/flower-expenses", label: "Расходы на цветы" }] : []),
    { href: "/dashboard/f/pickup", label: "Мои точки забора" },
    { href: "/dashboard/f/print-notes", label: "Печать записок" },
  ];

  return (
    <AppShell user={user} nav={nav}>
      {children}
    </AppShell>
  );
}
