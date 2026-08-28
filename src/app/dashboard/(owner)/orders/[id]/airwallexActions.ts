"use server";
/**
 * Ручная сверка платежа с Airwallex.
 *
 * Нужна потому, что расписание опроса намеренно редкое: после неудачной попытки следующий
 * заход — через шесть часов, чтобы не долбить чужой API по мёртвому платежу. Но владелец,
 * который прямо сейчас видит в кабинете Airwallex прошедший платёж, а у себя «Платёж не
 * прошёл», не должен ждать эти шесть часов и не иметь ни одной кнопки (THEFLOW-20612).
 *
 * Сверка идёт тем же путём, что и по расписанию (`reconcileAirwallexPayment`), — второй дороги
 * к платёжному статусу быть не должно.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { reconcileAirwallexPayment } from "@/integrations/airwallex/reconcile";

export type VerifyResult = { ok?: true; message?: string; error?: string };

/**
 * Каждый исход сверки — человеческой фразой. Показывать код («no_record») значит требовать от
 * владельца знания внутренних имён ради ответа на простой вопрос «ну и что там с деньгами».
 */
const OUTCOME_TEXT: Record<string, string> = {
  reconciled: "Проверено: платёж прошёл, статус обновлён.",
  pending: "Airwallex ещё обрабатывает платёж.",
  cancelled: "Airwallex сообщает: платёж отменён.",
  failed: "Airwallex подтверждает: платёж не прошёл.",
  not_found: "Airwallex не знает такого платежа.",
  not_found_retry: "Airwallex пока не видит платёж — проверим ещё раз позже.",
  unknown: "Airwallex вернул статус, который мы не распознали.",
  intent_replaced: "У заказа новая попытка оплаты — сверяем её.",
  no_record: "У заказа нет платежа Airwallex — сверять нечего.",
  not_configured: "У магазина не заданы ключи Airwallex.",
  monitoring_disabled: "Мониторинг Airwallex выключен для этого магазина.",
  order_gone: "Заказ не найден.",
  error: "Airwallex не ответил — попробуйте ещё раз через минуту.",
};

export async function verifyAirwallexAction(orderId: string): Promise<VerifyResult> {
  await requireRole("OWNER");

  try {
    const res = await reconcileAirwallexPayment(prisma, orderId);
    revalidatePath(`/dashboard/orders/${orderId}`);
    const message = OUTCOME_TEXT[res.outcome] ?? `Проверено (${res.outcome}).`;
    // «error» — это не результат сверки, а её отсутствие: показываем как ошибку, иначе владелец
    // решит, что Airwallex ответил и подтвердил текущий статус.
    return res.outcome === "error" ? { error: message } : { ok: true, message };
  } catch (err) {
    // Чужой API мог не ответить. Говорим об этом прямо: «ничего не изменилось» здесь не то же
    // самое, что «платёж действительно не прошёл».
    console.error(`[airwallex] ручная сверка ${orderId} не удалась:`, err instanceof Error ? err.message : String(err));
    return { error: "Airwallex не ответил — попробуйте ещё раз через минуту." };
  }
}
