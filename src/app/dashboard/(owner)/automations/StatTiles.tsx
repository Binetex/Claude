import Link from "next/link";

/**
 * Плитки со сводкой. Один вид на все экраны Automations: одиночные правила, цепочки, история.
 * Плитка со ссылкой работает как фильтр (кликнул «Ошибки» — увидел только их), без ссылки —
 * просто число.
 */

export type StatTile = {
  key: string;
  label: string;
  value: number;
  accent?: string;
  href?: string;
  active?: boolean;
};

const BASE = "rounded-xl border bg-white px-3 py-2 shadow-sm";

export function StatTiles({ tiles, caption }: { tiles: StatTile[]; caption?: string }) {
  return (
    <div className="space-y-1">
      {caption && <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{caption}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => {
          const body = (
            <>
              <div className={`text-lg font-semibold tabular-nums ${t.accent ?? "text-slate-800"}`}>{t.value}</div>
              <div className="text-[11px] text-slate-500">{t.label}</div>
            </>
          );
          if (!t.href) {
            return (
              <div key={t.key} className={`${BASE} border-slate-200`}>
                {body}
              </div>
            );
          }
          return (
            <Link
              key={t.key}
              href={t.href}
              className={t.active ? `${BASE} border-slate-800` : `${BASE} border-slate-200 hover:border-slate-300 hover:bg-slate-50`}
            >
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
