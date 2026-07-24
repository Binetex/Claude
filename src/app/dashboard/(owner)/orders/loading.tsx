import { CardListSkeleton } from "@/components/ui/states";

/**
 * Показывается при входе в раздел, пока сервер собирает первую выборку.
 * Смену фильтров и страниц внутри уже открытого раздела этот файл не покрывает —
 * там ожидание рисует OrdersNav (см. комментарий в OrdersNav.tsx).
 */
export default function Loading() {
  return <CardListSkeleton rows={6} />;
}
