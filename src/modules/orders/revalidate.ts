import "server-only";
/**
 * Обновление страниц заказа после правки.
 *
 * Один заказ живёт на ТРЁХ дашбордах: владелец (/dashboard/orders), флорист (/dashboard/f) и
 * колл-центр (/dashboard/cc). Обновить только свой путь значит оставить остальных со старой
 * картинкой: 20.09.2026 флорист трижды жаловался, что привязывает Burq-ссылку с телефона и
 * «ничего не происходит» — привязка проходила, но его страница не перерисовывалась, потому что
 * действие обновляло только путь владельца.
 *
 * Вынесено отдельным модулем, а не экспортом из editActions: тот файл помечен "use server",
 * и любой его экспорт становится серверным действием, доступным из браузера.
 */
import { revalidatePath } from "next/cache";

export function revalidateOrder(orderId: string): void {
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath("/dashboard/cc");
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath("/dashboard/f");
}
