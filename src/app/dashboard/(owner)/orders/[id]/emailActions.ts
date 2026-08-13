"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { sendOrderEmail } from "@/integrations/emailFactory/send";

type FormState = { ok?: boolean; error?: string } | null;

const ERR_RU: Record<string, string> = {
  empty_text: "Введите текст письма.",
  too_long: "Слишком длинное письмо (макс. 10 000 символов).",
  missing_idempotency_key: "Повторите отправку.",
  no_customer_email: "В заказе не указан e-mail заказчика — писать некому.",
  order_not_found: "Заказ не найден.",
  email_factory_not_configured: "Email Factory не подключён: введите токен в настройках.",
  previous_attempt_failed: "Прошлая попытка не удалась и письмо не ушло. Нажмите «Ответить» ещё раз.",
  ef_unauthorized: "Email Factory отклонил запрос: проверьте токен.",
  ef_thread_not_found: "Тред переписки не найден на стороне почты.",
  ef_validation_error: "Почта отклонила письмо — подробности в истории переписки.",
  no_sending_domain: "В Email Factory нет ни одного подтверждённого домена — писать не с чего.",
  domain_not_selected: "У магазина не выбран домен Email Factory — задайте его в настройках сайта.",
  domain_not_ready: "Домен магазина больше не подтверждён в Email Factory — проверьте его там.",
  ef_rate_limit: "Слишком часто — попробуйте через минуту.",
  ef_server: "Почта временно недоступна, попробуйте позже.",
  ef_network: "Сетевая ошибка при обращении к почте.",
  ef_timeout: "Почта не ответила вовремя.",
  ef_client: "Почта отклонила запрос.",
  ef_bad_response: "Неожиданный ответ почты.",
};

/**
 * Письмо клиенту из карточки заказа — ответ в переписку или первое письмо, если её ещё нет.
 * Доступно ЛЮБОМУ сотруднику, как и отправка SMS: переписку ведёт тот, кто работает с заказом.
 *
 * Адресат НЕ приходит из браузера: сервер берёт его из переписки или из самого заказа. Иначе
 * подменой поля можно было бы написать кому угодно от имени магазина.
 */
export async function sendOrderEmailReplyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const orderId = String(formData.get("orderId") ?? "");
  const text = String(formData.get("text") ?? "");
  const sendKey = String(formData.get("idempotencyKey") ?? "");
  if (!orderId) return { error: "Некорректный запрос." };

  const res = await sendOrderEmail(prisma, { orderId, text, sendKey, sentByUserId: user.id });
  revalidatePath(`/dashboard/orders/${orderId}`);
  if (res.ok) return { ok: true };
  return { error: ERR_RU[res.code] ?? "Не удалось отправить письмо." };
}
