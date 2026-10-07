"use server";
/**
 * Загрузка фото букета — общее действие для всех, кто ведёт заказ: флориста, колл-центра и
 * владельца. Лежит в модуле, а не рядом со страницей, потому что страниц три.
 */
import { revalidatePath } from "next/cache";
import { requireOrderEditor } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { sendOrderSms } from "@/integrations/quo/send";
import { bouquetMediaName, bouquetPageUrl } from "@/lib/bouquetPage";
import { saveBouquetPhoto } from "./bouquetPhoto";

export type UploadBouquetPhotoResult = { ok?: true; error?: string };

export async function uploadBouquetPhotoAction(orderId: string, photoDataUrl: string): Promise<UploadBouquetPhotoResult> {
  const user = await requireOrderEditor();
  const res = await saveBouquetPhoto(orderId, photoDataUrl, { role: user.role, floristId: user.floristId });
  if (!res.ok) return { error: res.error };

  // Карточка заказа открыта в трёх кабинетах — обновляем все: фото одно на заказ.
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath(`/dashboard/orders/${orderId}`);
  return { ok: true };
}

/** Текст клиенту к фото — по-английски, как и всё, что уходит наружу. Не экспортируется: в
 *  "use server"-модуле наружу можно отдавать только async-функции. Без браузера Quo вместо
 *  картинки под ним встанет ссылка на страницу фото. */
const BOUQUET_PHOTO_SMS = "Here is your bouquet!";

export type SendBouquetPhotoResult = { ok?: true; message?: string; error?: string };

/** Коды отправки — человеку, а не в лог: он должен понять, что делать дальше. */
const SEND_ERRORS: Record<string, string> = {
  order_not_found: "Заказ не найден.",
  invalid_target_phone: "У заказчика нет пригодного номера телефона.",
  store_no_quo_number: "У магазина не задан номер отправителя.",
  store_quo_disabled: "SMS у этого магазина выключены.",
  quo_not_configured: "SMS не настроены на сервере.",
  previous_attempt_failed: "Прошлая отправка этого фото не удалась — замените фото и попробуйте снова.",
  too_long: "Сообщение получилось слишком длинным.",
};

/**
 * Отправляет заказчику фото букета одним нажатием.
 *
 * Картинкой (MMS) — браузером Quo: в их API вложений нет, а в приложении есть (владелец 07.10.2026).
 * Браузер недоступен — уходит, как раньше, ссылка на публичную страницу `/bouquet/<файл>`, где нет
 * ни номера заказа, ни имён (см. lib/bouquetPage.ts).
 *
 * Адресат — ЗАКАЗЧИК: букет заказывают в подарок, и фото ждёт тот, кто платил, а не получатель,
 * для которого это сюрприз. Ключ идемпотентности включает имя файла: двойное нажатие второго
 * SMS не создаёт, а после замены фото отправить можно снова.
 */
export async function sendBouquetPhotoLinkAction(orderId: string): Promise<SendBouquetPhotoResult> {
  const user = await requireOrderEditor();

  const scope = user.role === "FLORIST" ? { id: orderId, currentFloristId: user.floristId } : { id: orderId };
  const order = await prisma.order.findFirst({ where: scope, select: { bouquetPhotoUrl: true } });
  if (!order) return { error: "Заказ недоступен." };

  const url = bouquetPageUrl(order.bouquetPhotoUrl);
  const name = bouquetMediaName(order.bouquetPhotoUrl);
  if (!url || !name) return { error: "Сначала загрузите фото букета." };

  const cfg = getQuoConfig();
  const client = cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;
  const base = { orderId, target: "CUSTOMER" as const, idempotencyKey: `bouquet-photo:${orderId}:${name}`, sentByUserId: user.id };
  let res = await sendOrderSms(prisma, client, { ...base, text: BOUQUET_PHOTO_SMS, attachments: [{ name, fallbackUrl: url }] });
  // Фото не годится в MMS (старое, до сжатия в браузере: webp, больше 5 МБ) — ссылкой, как раньше.
  // Записи под ключом при этом ещё нет: проверка вложения идёт до неё.
  if (!res.ok && res.code.startsWith("attachment_")) res = await sendOrderSms(prisma, client, { ...base, text: `${BOUQUET_PHOTO_SMS}\n${url}` });
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath(`/dashboard/orders/${orderId}`);
  if (!res.ok) return { error: SEND_ERRORS[res.code] ?? "Не удалось отправить SMS." };
  // Повторное нажатие: второго SMS нет, и человек должен об этом узнать, а не думать, что ушло второе.
  if (res.duplicate) return { ok: true, message: "Это фото клиенту уже отправляли." };
  return { ok: true, message: "Фото отправлено заказчику." };
}
