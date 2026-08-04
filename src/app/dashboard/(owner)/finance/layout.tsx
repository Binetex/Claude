import { requireRole } from "@/lib/rbac";
import { getIssueSummary } from "@/modules/finance/issues";
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

  const issues = await getIssueSummary();

  // Три пункта, и все три — про весь бизнес. Всё, что относится к ОДНОМУ флористу (его
  // заработок, выплаты, доля, дневная закупка цветов), живёт внутри его кабинета:
  // «Флористы → флорист». Раньше те же данные висели ещё и верхним уровнем —
  // «Доля основного флориста» и «Расходы на цветы» — и это были копии его же экранов.
  //
  // «Разбор заказов» убран: список был только для чтения (колонка действий пустая), а все
  // три его причины — нет флориста, нет цены, нет модели оплаты — видны прямо в карточке
  // заказа, где их и исправляют.
  const tabs: FinanceTab[] = [
    { href: "/dashboard/finance/florists", label: "Флористы" },
    {
      href: "/dashboard/finance/setup",
      label: "Требует заполнения",
      badge: issues.blocking + issues.warning,
      alarming: issues.blocking > 0,
    },
    { href: "/dashboard/finance/settings", label: "Настройки расчёта" },
  ];

  return (
    <div className="space-y-4">
      <FinanceTabs tabs={tabs} />
      {children}
    </div>
  );
}
