import { requireRole } from "@/lib/rbac";
import { getIssueSummary } from "@/modules/finance/issues";
import { getReviewCounts } from "@/modules/finance/review";
import { FinanceTabs, type FinanceTab } from "./FinanceTabs";

/**
 * Общая обвязка раздела «Финансы»: вкладки на каждой странице.
 *
 * Layout, а не копия в каждой странице, — чтобы вложенные экраны (снимок заказа, массовое
 * подтверждение доставки) не оказывались без выхода наружу.
 *
 * requireRole здесь дублирует проверку страниц СОЗНАТЕЛЬНО: layout защищает и те страницы,
 * которые кто-то добавит в раздел позже и забудет закрыть.
 */
export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  await requireRole("OWNER");

  const [issues, review] = await Promise.all([getIssueSummary(), getReviewCounts()]);

  const tabs: FinanceTab[] = [
    { href: "/dashboard/finance/florists", label: "Флористы" },
    { href: "/dashboard/finance/share", label: "Доля основного флориста" },
    { href: "/dashboard/finance/flower-expenses", label: "Расходы на цветы" },
    {
      href: "/dashboard/finance/setup",
      label: "Требует заполнения",
      badge: issues.blocking + issues.warning,
      alarming: issues.blocking > 0,
    },
    { href: "/dashboard/finance/settings", label: "Настройки расчёта" },
    {
      href: "/dashboard/finance/review",
      label: "Разбор заказов",
      badge: review.noFlorist + review.needsPrice,
      alarming: review.noFlorist + review.needsPrice > 0,
    },
  ];

  return (
    <div className="space-y-4">
      <FinanceTabs tabs={tabs} />
      {children}
    </div>
  );
}
