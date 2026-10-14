"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Флорист раздела «Расходники» — над всеми страницами (владелец 14.10.2026: «легко переключаться
 * между флористами, общее можно, но важнее видеть у каждого»). Выбор живёт в адресе (`?florist=`),
 * поэтому переживает переход между «Журналом», днём и «Приходом и остатком»; месяц и прочие
 * параметры страницы сохраняются.
 */
export function FloristSwitcher({ florists }: { florists: { id: string; name: string }[] }) {
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  // В справочнике флорист ни при чём — переключатель там только путал бы.
  if (pathname.startsWith("/dashboard/consumables/items")) return null;
  const current = params?.get("florist") ?? "";

  const hrefFor = (id: string) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (id) next.set("florist", id);
    else next.delete("florist");
    const q = next.toString();
    return q ? `${pathname}?${q}` : pathname;
  };

  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="Флорист">
      {[...florists, { id: "", name: "Все флористы" }].map((f) => (
        <Link
          key={f.id || "all"}
          href={hrefFor(f.id)}
          aria-current={current === f.id ? "page" : undefined}
          className={
            current === f.id
              ? "rounded-full border border-sky-300 bg-sky-50 px-3 py-1 font-medium text-sky-700"
              : "rounded-full border border-slate-200 px-3 py-1 text-slate-600 hover:bg-slate-50"
          }
        >
          {f.name}
        </Link>
      ))}
    </nav>
  );
}
