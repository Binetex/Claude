"use client";
/**
 * Вкладки раздела «Настройки». Всё редкое и настроечное собрано здесь одним пунктом меню
 * вместо четырёх отдельных строк рядом с ежедневной работой.
 *
 * «Системных событий» здесь намеренно НЕТ: экран владельцу в работе не нужен и долго грузится
 * (сотни записей outbox). Страница жива по /dashboard/settings/system-events — туда ведёт
 * красная полоса о нулевом балансе QUO, когда действительно надо посмотреть очередь.
 *
 * Вкладка «Доставка (Burq)» ведёт ВНЕ сегмента: страница живёт по /dashboard/burq, потому что
 * доступна не только владельцу (см. dashboard/burq/layout.tsx). Поэтому компонент подключается
 * и там, а активная вкладка ищется по префиксу, а не по совпадению адреса.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/settings/users", label: "Пользователи" },
  { href: "/dashboard/settings/telegram", label: "Telegram" },
  { href: "/dashboard/settings/ai", label: "Модель ассистента" },
  { href: "/dashboard/settings/print", label: "Настройки печати" },
  { href: "/dashboard/burq", label: "Доставка (Burq)" },
] as const;

export function SettingsTabs() {
  const pathname = usePathname() ?? "";
  const active = TABS.map((t) => t.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav className="flex flex-wrap gap-1 border-b border-slate-200">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={
            t.href === active
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
