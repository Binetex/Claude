"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { linkBurqOrderAction } from "./deliveryActions";

/**
 * Ручная привязка существующего Burq Order (o_...) к заказу. Простая форма без preview-экрана:
 * ввод ID → «Привязать». Если у заказа уже есть активная доставка — сервер вернёт needsConfirm,
 * показываем короткое подтверждение «Заменить текущую доставку?».
 *
 * С ТЕЛЕФОНА форма раньше выглядела мёртвой: блок свёрнут, ответ сервера появлялся внутри него
 * под клавиатурой, а страница флориста вдобавок не перерисовывалась (действие обновляло только
 * путь владельца). Флорист жаловался трижды. Теперь блок остаётся открытым, пока есть что
 * сказать, кнопка явно показывает работу, а результат — крупной цветной плашкой сверху формы.
 *
 * ЛЮБОЙ ответ сервера показывается ОДНОЙ плашкой в ОДНОМ месте — сверху. Вопрос «заменить живую
 * доставку?» раньше плашки не имел: он менял только кнопку ниже по форме, и на телефоне под
 * открытой клавиатурой это читалось как «кнопка потухла и ничего не произошло». Человек обновлял
 * страницу, вопрос пропадал вместе с состоянием формы, и всё начиналось заново (24.09.2026).
 */
export function BurqLinkForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState(linkBurqOrderAction, null);
  const [value, setValue] = useState("");
  const needsConfirm = state?.needsConfirm === true;
  // Пока есть результат или идёт отправка, блок не даём свернуть: иначе ответ сервера прячется
  // вместе с ним, и на телефоне это читается как «кнопка не работает».
  const keepOpen = pending || !!state?.error || !!state?.ok || needsConfirm;

  return (
    <details className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs" open={keepOpen || undefined}>
      <summary className="cursor-pointer font-medium text-slate-600">Привязать существующий Burq Order</summary>
      {state?.ok && (
        <p className="mt-2 rounded border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-sm font-medium text-emerald-800">
          ✅ {state.message}
        </p>
      )}
      {state?.error && (
        <p className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-sm font-medium text-red-700">
          {state.error}
        </p>
      )}
      {needsConfirm && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm font-medium text-amber-800">
          ⚠️ {state?.message} Подтвердите замену кнопкой ниже.
        </p>
      )}
      {pending && <p className="mt-2 text-sm text-slate-500">Привязываю, одну секунду…</p>}
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="orderId" value={orderId} />
        <label className="block text-slate-500" htmlFor="burqOrderId">Burq Order ID</label>
        <input
          id="burqOrderId"
          name="burqOrderId"
          value={value}
          onChange={(e) => setValue(e.target.value.trim())}
          placeholder="o_..."
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs text-slate-800"
        />
        {needsConfirm ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-2">
            <input type="hidden" name="confirm" value="1" />
            <Button type="submit" variant="destructive" className="w-full sm:w-auto" disabled={pending || !value}>
              {pending ? "Замена…" : "Заменить живую доставку"}
            </Button>
          </div>
        ) : (
          <Button type="submit" className="w-full sm:w-auto" disabled={pending || !value}>
            {pending ? "Привязываю…" : "Привязать"}
          </Button>
        )}
      </form>
    </details>
  );
}
