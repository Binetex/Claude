/**
 * Окно доставки в том виде, в каком его читает американский клиент.
 *
 * `Order.deliveryWindow` приезжает из шести магазинов и лежит в базе как пришло: TheFlow и
 * Julie's отдают 24-часовые «15:00 - 19:00» и «09:00 - 15:00», Paradise, O'Hara, Flowerbar и
 * Plombir — уже «11:30 AM - 5:00 PM», а руками вписывают что угодно, вплоть до «желательно
 * первым». Клиенту при этом уходило ровно то, что лежит: больше двух третей заказов получали
 * время, которое в США никто так не пишет.
 *
 * Приводим ТОЛЬКО сами часы и только там, где в них нельзя ошибиться: у куска времени есть
 * минуты либо явное am/pm. Голое число («до 12») не трогаем: понять, полдень это или полночь,
 * неоткуда, а догадка в сообщении клиенту дороже неудобной записи. Всё, что вокруг времени,
 * остаётся как было — строка может быть и фразой, а не окном.
 */

/** Кусок времени: час с минутами и/или с am/pm. Голый час без того и другого не ловим. */
const TIME_TOKEN = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\.?\b|\b(\d{1,2})[:.](\d{2})\b/gi;

function render(hour24: number, minutes: number): string | null {
  if (hour24 < 0 || hour24 > 23 || minutes < 0 || minutes > 59) return null;
  const suffix = hour24 < 12 ? "AM" : "PM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  // «5:00 PM» и «5 PM» — одно и то же, и ровный час клиенту читается быстрее.
  return minutes === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function formatDeliveryWindow(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "";

  return text.replace(TIME_TOKEN, (match, hA, mA, ap, hB, mB) => {
    if (ap) {
      const hour = Number(hA);
      const minutes = mA === undefined ? 0 : Number(mA);
      // Час больше двенадцати рядом с am/pm («15:00 PM») — это 24-часовая запись с лишней
      // подписью. Верим часу, а не подписи: 15 не может быть тремя часами ночи.
      const hour24 = hour > 12 ? hour : ap.toLowerCase() === "p" ? (hour % 12) + 12 : hour % 12;
      return render(hour24, minutes) ?? match;
    }
    return render(Number(hB), Number(mB)) ?? match;
  });
}
