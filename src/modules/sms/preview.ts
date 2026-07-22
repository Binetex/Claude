import "server-only";
/**
 * Рендер preview автоматизации на реальном заказе: итоговый текст, значения переменных,
 * недоступные переменные и список фактических адресатов (с дедупом BOTH). Ничего не отправляет
 * и не меняет. Используется формой редактора («Показать preview»).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { buildOrderVariables } from "./variables";
import { renderTemplate } from "./template";
import { resolveRecipients, type SmsAudience } from "./audience";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "./orderSource";

export type PreviewResult =
  | { ok: false; error: string }
  | {
      ok: true;
      orderNumber: string;
      text: string;
      missing: string[];
      values: Record<string, string>;
      recipients: { recipientType: "CUSTOMER" | "RECIPIENT"; phoneNormalized: string }[];
      skipped: { recipientType: "CUSTOMER" | "RECIPIENT"; reason: string }[];
    };

export async function buildAutomationPreview(
  prisma: PrismaClient,
  args: { orderId: string; template: string; audience: SmsAudience }
): Promise<PreviewResult> {
  const order = await prisma.order.findUnique({ where: { id: args.orderId }, include: SMS_ORDER_INCLUDE });
  if (!order) return { ok: false, error: "order_not_found" };

  const values = buildOrderVariables(orderToVariableSource(order));
  const render = renderTemplate(args.template, values);
  const { recipients, skipped } = resolveRecipients(args.audience, {
    senderPhone: order.senderPhone,
    recipientPhone: order.recipientPhone,
  });

  return { ok: true, orderNumber: order.orderNumber, text: render.text, missing: render.missing, values, recipients, skipped };
}
