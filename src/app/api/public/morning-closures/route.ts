import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";

/**
 * Дни, на которые владелец закрыл утро замком в «Графике доставки».
 *
 * Читает сайт TheFlow (mu-plugin `floremart-morning-closures.php`): в эти дни он прячет утренний
 * слот у плагина доставки. Без авторизации: наружу уходят только даты, ни заказов, ни имён.
 * Сайт кэширует ответ на две минуты и при любой ошибке ничего не закрывает.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const rows = await prisma.morningClosure.findMany({ where: { day: { gte: today } }, select: { day: true }, orderBy: { day: "asc" } });
  return NextResponse.json({ days: rows.map((r) => r.day) }, { headers: { "Cache-Control": "no-store" } });
}
