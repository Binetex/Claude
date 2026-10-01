import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { siteDayClosures } from "@/modules/timing/load";

/**
 * Закрытые дни: замок в «Графике доставки» (утро, только вечер или весь день) и автозамок утра —
 * когда по графику утренний заказ TheFlow уже не успеваем на час и больше (`siteDayClosures`).
 *
 * Читают сайты с плагином доставки (mu-plugin `floremart-morning-closures.php`, TheFlow и JF): в
 * эти дни они прячут слоты раньше `openFrom`, а день с `openFrom: null` убирают из календаря.
 * `days` — все закрытые дни, как раньше: по нему прежняя версия плагина закрывает хотя бы утро.
 * Без авторизации: наружу уходят только даты и часы, ни заказов, ни имён. Сайт кэширует ответ на
 * две минуты и при любой ошибке ничего не закрывает.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const openFrom = await siteDayClosures(prisma);
  return NextResponse.json({ days: Object.keys(openFrom).sort(), openFrom }, { headers: { "Cache-Control": "no-store" } });
}
