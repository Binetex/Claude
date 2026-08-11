"use client";
import { useState } from "react";
import type { ReactNode } from "react";

/**
 * Вкладки настроек магазина. Разделы приходят СЕРВЕРНЫМИ узлами: страница магазина остаётся
 * серверной и рендерит панели как раньше, а этот компонент только показывает выбранный раздел.
 * Поэтому переключение не ходит на сервер и не перезагружает страницу — при этом ни одна панель
 * не превращается в клиентскую.
 *
 * Все разделы монтируются сразу и прячутся стилями, а не размонтируются: у панелей внутри есть
 * несохранённый ввод (адрес отправителя, инструкции курьеру), и терять его при переключении
 * вкладки нельзя.
 */
export type SettingsSection = {
  key: string;
  label: string;
  /**
   * Состояние раздела кружком: зелёный — работает, красный — не работает, серый — нечего
   * включать. Текстовые пометки рядом с названиями превращали строку вкладок в мешанину слов,
   * поэтому состояние показывается цветом, а словами — только в подсказке при наведении.
   */
  state?: { ok: boolean; title: string } | null;
  content: ReactNode;
};

export function SiteSettingsTabs({ sections }: { sections: SettingsSection[] }) {
  const [active, setActive] = useState(sections[0]?.key ?? "");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {sections.map((s) => {
          const isActive = s.key === active;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setActive(s.key)}
              className={
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                (isActive ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100")
              }
            >
              {s.state && (
                <span
                  title={s.state.title}
                  aria-label={s.state.title}
                  className={"h-2 w-2 shrink-0 rounded-full " + (s.state.ok ? "bg-emerald-500" : "bg-red-500")}
                />
              )}
              {s.label}
            </button>
          );
        })}
      </div>

      {sections.map((s) => (
        <div key={s.key} className={s.key === active ? "space-y-4" : "hidden"}>
          {s.content}
        </div>
      ))}
    </div>
  );
}
