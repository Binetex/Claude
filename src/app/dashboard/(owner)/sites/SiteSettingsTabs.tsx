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
  /** Короткая пометка справа от названия: «вкл», «нет ключа» и т.п. Не обязательна. */
  hint?: string | null;
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
              {s.label}
              {s.hint && (
                <span
                  className={
                    "rounded px-1 py-px text-[10px] font-normal " +
                    (isActive ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500")
                  }
                >
                  {s.hint}
                </span>
              )}
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
