"use client";
import { useRef, useState } from "react";
import { Printer } from "lucide-react";
import { printCardsUrl } from "@/lib/print/printUrl";
import { cn } from "@/lib/cn";

/**
 * Печать открытки одного заказа. Открывает тот же документ /print/order-cards, что и вкладка
 * «Открытки для печати» — своего шаблона и своего генератора здесь нет, PDF делает браузер
 * из печатной страницы.
 *
 * Печатается СОХРАНЁННЫЙ текст: документ читает заказ из БД. Поэтому при несохранённых
 * правках кнопка предупреждает, а не печатает старую версию молча (так же ведёт себя
 * кнопка на вкладке печати).
 */
export function PrintCardButton({
  orderId,
  hasCardMessage,
  dirty = false,
  className,
}: {
  orderId: string;
  /** Пустая открытка — печатать нечего, документ был бы пустым. */
  hasCardMessage: boolean;
  dirty?: boolean;
  className?: string;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  // Защита от двойного клика: без неё быстрые нажатия открывают несколько вкладок.
  const openedAt = useRef(0);

  const disabled = !hasCardMessage;

  function onClick() {
    setMsg(null);
    if (dirty) {
      setMsg("Сначала сохраните текст открытки");
      return;
    }
    const now = Date.now();
    if (now - openedAt.current < 1500) return;
    openedAt.current = now;

    const w = window.open(printCardsUrl(orderId), "_blank", "noopener");
    // Блокировщик всплывающих окон — молчаливый отказ выглядел бы как «кнопка не работает».
    if (!w) setMsg("Разрешите всплывающие окна для печати");
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {msg && <span className="text-[11px] text-amber-600">{msg}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={disabled ? "В заказе нет текста открытки" : "Печать открытки"}
        className={cn(
          "inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white transition-colors",
          "hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300",
          className
        )}
      >
        <Printer className="size-3.5" />
        Печать
      </button>
    </span>
  );
}
