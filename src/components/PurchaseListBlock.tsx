import { getTodayPurchaseList, purchaseListToText } from "@/modules/purchase/list";
import { PurchaseList } from "./PurchaseList";

/**
 * Серверный блок «Сегодня нужно купить». Владелец — все заказы (без floristId),
 * флорист — только назначенные ему (floristId). Колл-центру блок не показываем.
 */
export async function PurchaseListBlock({ floristId }: { floristId?: string }) {
  const items = await getTodayPurchaseList(floristId ? { floristId } : {});
  return <PurchaseList items={items} text={purchaseListToText(items)} />;
}
