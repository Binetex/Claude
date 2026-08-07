import { Package } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderItemImages } from "@/components/OrderItemImages";
import { OrderItemComposition } from "@/components/OrderItemComposition";
import { formatMoney } from "@/lib/money";

/**
 * Блок «Товары» карточки заказа. Один на владельца, колл-центр и флориста.
 *
 * Раньше вёрстка была написана трижды и разошлась: у флориста чип количества и одна цена,
 * у владельца «× N» в потоке текста и две цены, у колл-центра фото меньше и цен нет вовсе.
 * Роль задаёт ТОЛЬКО данные — какие цены и подписи передали, такие и показаны; сама
 * раскладка, размеры фото и переносы общие.
 */
export type OrderItemPrice = {
  value: number;
  /** Подпись под суммой: «вам», «клиенту», «заказчику», «флористу». */
  label: string;
  /**
   * Цена не задана в каталоге. Показываем словами, а не «$0.00»: ноль читается как
   * «бесплатно» и прячет незаполненный прайс. Заметить это должен владелец — до того,
   * как заказ уйдёт в расчёт.
   */
  missing?: boolean;
};

export type OrderItemView = {
  id: string;
  name: string;
  quantity: number;
  image: string | null;
  variantImage: string | null;
  variantName?: string | null;
  floristComposition?: string | null;
  /** Ноль, одна или две строки цены. Пустой массив — цен у роли нет. */
  prices?: OrderItemPrice[];
  /** Действие под составом (у владельца — «Обновить состав из товара»). */
  action?: React.ReactNode;
};

export function OrderItemsCard({
  items,
  showMissingCompositionHint = true,
}: {
  items: OrderItemView[];
  /**
   * Подсказка «Состав варианта не указан». Флористу не адресована: заполнить каталог он не
   * может, а строка повторялась бы у каждой позиции.
   */
  showMissingCompositionHint?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={Package}>Товары</CardTitle></CardHeader>
      <CardBody className="p-0">
        <ul className="divide-y divide-slate-100">
          {/* flex-wrap + минимальная ширина текста: на телефоне колонка цен занимает почти всю
              ширину и оставляла названию считанные пиксели. Цена переносится на свою строку и
              прижимается вправо. На широком экране строка по-прежнему одна. */}
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
              <OrderItemImages image={it.image} variantImage={it.variantImage} size="h-14 w-14" />
              <div className="min-w-[10rem] flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                  <span className="min-w-0 break-words sm:truncate">{it.name}</span>
                  {/* Количество отдельным чипом: «× 1» в потоке текста сливается с названием. */}
                  <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500 tabular-nums">
                    ×{it.quantity}
                  </span>
                </div>
                <OrderItemComposition
                  variantName={it.variantName}
                  floristComposition={it.floristComposition}
                  showMissingHint={showMissingCompositionHint}
                />
                {it.action}
              </div>
              {it.prices && it.prices.length > 0 && (
                <div className="ml-auto text-right whitespace-nowrap">
                  {it.prices.map((p, i) => (
                    <div key={p.label}>
                      <span
                        className={
                          p.missing
                            ? "text-sm font-medium text-amber-700"
                            : i === 0
                              ? "text-sm font-medium text-slate-800 tabular-nums"
                              : "text-sm text-slate-500 tabular-nums"
                        }
                      >
                        {p.missing ? "не задана" : formatMoney(p.value)}
                      </span>
                      <div className="text-[11px] text-slate-400">{p.label}</div>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
