import "server-only";
/**
 * Заготовки ответов клиенту: чтение и подстановка данных заказа.
 *
 * Заготовка ничего не отправляет. Она кладёт готовый текст в поле отправки, дальше человек его
 * правит и жмёт «Отправить» — тем же действием, что и при обычном ручном ответе. Поэтому здесь
 * нет ни проверок прав на отправку, ни идемпотентности: всё это живёт на пути самой отправки.
 *
 * Переменные — те же, что в шаблонах автоматизаций (modules/messaging/variables.ts): один
 * реестр на оба места, иначе {{recipient_name}} в двух редакторах значил бы разное.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { renderTemplate } from "./template";
import { buildOrderVariables } from "./variables";
import { orderToVariableSource, SMS_ORDER_INCLUDE } from "./orderSource";

export type TemplateChoice = { id: string; title: string; text: string; missing: string[] };

/**
 * Заготовки, готовые к вставке по конкретному заказу. Переменные уже подставлены: человек видит
 * тот текст, который уйдёт, а не «{{recipient_name}}».
 *
 * `missing` — переменные, для которых данных не нашлось (нет трек-ссылки, не заполнен адрес).
 * Строку с пустой переменной `renderTemplate` выбрасывает целиком, и без этого списка заготовка
 * молча приезжала бы короче, чем её писали.
 */
export async function loadTemplatesForOrder(prisma: PrismaClient, orderId: string | null): Promise<TemplateChoice[]> {
  const rows = await prisma.messageTemplate.findMany({
    where: { active: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, text: true },
  });
  if (rows.length === 0) return [];

  const order = orderId ? await prisma.order.findUnique({ where: { id: orderId }, include: SMS_ORDER_INCLUDE }) : null;
  // Заказа нет (переписка с незнакомым номером) — отдаём тексты как есть: подставлять нечего,
  // а прятать заготовки значило бы оставить оператора без единой кнопки там, где он пишет чаще
  // всего.
  if (!order) return rows.map((r) => ({ id: r.id, title: r.title, text: r.text, missing: [] }));

  const vars = buildOrderVariables(orderToVariableSource(order));
  return rows.map((r) => {
    const { text, missing } = renderTemplate(r.text, vars);
    return { id: r.id, title: r.title, text, missing };
  });
}
