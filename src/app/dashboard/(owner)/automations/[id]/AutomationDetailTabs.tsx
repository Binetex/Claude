import Link from "next/link";

/**
 * Подвкладки конкретного правила: настройка отдельно от статистики. Активная вкладка живёт
 * в URL (?tab=stats), поэтому ссылку на статистику можно переслать и «назад» работает.
 * Клиентского состояния не нужно — вкладка известна из searchParams на сервере.
 */
export function AutomationDetailTabs({ automationId, active }: { automationId: string; active: "settings" | "stats" }) {
  const tabs = [
    { key: "settings" as const, label: "Настройка", href: `/dashboard/automations/${automationId}` },
    { key: "stats" as const, label: "Статистика", href: `/dashboard/automations/${automationId}?tab=stats` },
  ];

  return (
    <nav className="flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={
            t.key === active
              ? "-mb-px border-b-2 border-slate-800 px-3 py-2 text-sm font-medium text-slate-800"
              : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-slate-500 hover:text-slate-700"
          }
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
