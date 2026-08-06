import { getPurchaseList, purchaseListToText, type PurchaseDay } from "@/modules/purchase/list";
import { PurchaseList } from "./PurchaseList";

/**
 * Серверный блок «нужно купить». Владелец — все заказы (без floristId),
 * флорист — только назначенные ему (floristId). Колл-центру блок не показываем.
 *
 * День берётся из активной вкладки списка заказов: закупка отвечает на вопрос «что покупать
 * к тому, что я сейчас вижу». На вкладках «Все» и «Готовые» дня нет — там заказы за разные
 * даты, одного списка закупки для них не существует, поэтому блок просто не выводится.
 */
export async function PurchaseListBlock({ floristId, day }: { floristId?: string; day?: PurchaseDay }) {
  if (!day) return null;
  const items = await getPurchaseList({ day, ...(floristId ? { floristId } : {}) });
  return <PurchaseList items={items} text={purchaseListToText(items, day)} day={day} />;
}
