import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";
import { asClosureLevel, CLOSURE_OPEN_FROM } from "@/modules/timing/day";

/**
 * Дни, закрытые замком в «Графике доставки»: утро, только вечер или весь день.
 *
 * Читают сайты с плагином доставки (mu-plugin `floremart-morning-closures.php`, TheFlow и JF): в
 * эти дни они прячут слоты раньше `openFrom`, а день с `openFrom: null` убирают из календаря.
 * `days` — все закрытые дни, как раньше: по нему прежняя версия плагина закрывает хотя бы утро.
 * Без авторизации: наружу уходят только даты и часы, ни заказов, ни имён. Сайт кэширует ответ на
 * две минуты и при любой ошибке ничего не закрывает.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const rows = await prisma.morningClosure.findMany({ where: { day: { gte: today } }, select: { day: true, level: true }, orderBy: { day: "asc" } });
  const openFrom: Record<string, number | null> = {};
  for (const r of rows) openFrom[r.day] = CLOSURE_OPEN_FROM[asClosureLevel(r.level) ?? "MORNING"];
  return NextResponse.json({ days: rows.map((r) => r.day), openFrom }, { headers: { "Cache-Control": "no-store" } });
}
