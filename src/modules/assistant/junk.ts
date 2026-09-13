import "server-only";
/**
 * Сообщения, на которые ассистент не тратит ни ответа, ни запроса к модели.
 *
 * Рассылки про кредиты («Hi Emanouel, I can fund up to $2M») приходят на номера магазинов
 * десятками в неделю — и 05.09.2026 на одну такую клиенту магазина Par ушёл живой ответ
 * «Could you tell me the name on the order». Решать это правилом, а не моделью, надёжнее и
 * дешевле: модель угадывает спам неплохо, но ошибается наружу, а правило ошибается в молчание.
 *
 * Тот же список категорий, что на экране «Другие сообщения»: второй копии правил быть не должно.
 * Берём только две категории, где ответ бессмыслен ВСЕГДА:
 *  - SPAM — рассылки о финансировании и реклама;
 *  - SERVICE — автоответы операторов («this line is not monitored») и коды подтверждения.
 * Всё остальное (в том числе «ищут работу») по-прежнему решает модель: там на том конце человек.
 */
import { classifyThread } from "@/integrations/quo/otherMessages";

/** Причина молчания для журнала или null, если сообщение живое. */
export function junkReason(text: string): "spam_rule" | "service_rule" | null {
  if (!text.trim()) return null;
  const topic = classifyThread([text]);
  if (topic === "SPAM") return "spam_rule";
  if (topic === "SERVICE") return "service_rule";
  return null;
}
