import { requireFlorist } from "@/lib/rbac";
import { FinanceTabs, type FinanceTab } from "@/app/dashboard/(owner)/finance/FinanceTabs";

/**
 * Обвязка раздела «Мои финансы»: два понятных раздела вместо одной страницы обо всём.
 *
 * Заработок отвечает на вопрос «сколько я заработал и из каких заказов», история выплат —
 * «когда и сколько мне выплатили». Смешивать их на одном экране означало показывать сумму
 * рядом со списком, из которого она не складывается.
 *
 * requireFlorist здесь дублирует проверку страниц сознательно: layout закроет и ту страницу,
 * которую кто-то добавит в раздел позже.
 */
const tabs: FinanceTab[] = [
  { href: "/dashboard/f/finance", label: "Заработок" },
  { href: "/dashboard/f/finance/payouts", label: "История выплат" },
];

export default async function FloristFinanceLayout({ children }: { children: React.ReactNode }) {
  await requireFlorist();
  return (
    <div className="space-y-4">
      <FinanceTabs tabs={tabs} />
      {children}
    </div>
  );
}
