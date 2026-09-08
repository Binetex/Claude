import { redirect } from "next/navigation";

/**
 * Корень раздела «Отзывы» открывается на РАБОТЕ — просроченных запросах, а не на справочнике
 * точек: с вопроса «как идёт» в раздел и заходят, а точки правят редко (см. reviews/layout.tsx).
 * Адрес /dashboard/reviews остаётся редиректом, чтобы пункт меню, закладки и подсветка
 * активного пункта в сайдбаре (работает по префиксу) продолжали работать.
 */
export default function ReviewsIndexPage() {
  redirect("/dashboard/reviews/requests");
}
