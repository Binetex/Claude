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

/** Текст клиенту — по-английски, как и всё, что уходит наружу. Не экспортируется: в
 *  "use server"-модуле наружу можно отдавать только async-функции. */
const bouquetPhotoSms = (url: string) => `Here is your bouquet: ${url}`;

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
 * Отправляет заказчику ссылку на фото букета одним нажатием.
 *
 * Именно ссылку, а не картинку: QUO (OpenPhone) по API умеет только текст, MMS у них есть в
 * приложении, но не в API. Ссылка ведёт на публичную страницу `/bouquet/<файл>`, где нет ни
 * номера заказа, ни имён (см. lib/bouquetPage.ts).
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
  const res = await sendOrderSms(prisma, client, {
    orderId,
    target: "CUSTOMER",
    text: bouquetPhotoSms(url),
    idempotencyKey: `bouquet-photo:${orderId}:${name}`,
    sentByUserId: user.id,
  });
  revalidatePath(`/dashboard/f/${orderId}`);
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath(`/dashboard/orders/${orderId}`);
  if (!res.ok) return { error: SEND_ERRORS[res.code] ?? "Не удалось отправить SMS." };
  // Повторное нажатие: второго SMS нет, и человек должен об этом узнать, а не думать, что ушло второе.
  if (res.duplicate) return { ok: true, message: "Это фото клиенту уже отправляли." };
  return { ok: true, message: "Ссылка на фото отправлена заказчику." };
}
