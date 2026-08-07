import { requireRole } from "@/lib/rbac";
import { PrintDocument } from "../PrintDocument";
import { loadPrintSettings } from "@/modules/print/settingsStore";
import type { PrintLayout } from "@/modules/print/settings";
import type { PrintOrder } from "@/modules/print/loadPrintable";

export const dynamic = "force-dynamic";

/**
 * Образец печати для владельца. Заказы ВЫДУМАННЫЕ и в БД не ходят — это правило «печатает
 * только флорист и только свои заказы» не нарушает, а как раз позволяет его сохранить:
 * владелец видит, что делают его настройки, не получая доступа к чужим запискам.
 *
 * Три записки нарочно разной длины: короткая идёт максимальным кеглем, средняя — на
 * ступень мельче, длинная упирается в минимум. По ним и видно, что дают правки кегля.
 */

const SHORT = "С днём рождения!";

const MEDIUM = `Дорогая Анна!

Поздравляю с юбилеем. Пусть этот день будет тёплым,
а год — щедрым на хорошие новости.

Всегда твой, Михаил`;

const LONG = `Дорогие Анна и Михаил!

Сегодня ровно двадцать пять лет с того дня, и мне до сих пор кажется, что это было позавчера. Помню, как мы всей компанией не могли найти зал, как дождь начался ровно в ту минуту, когда все вышли на улицу, и как это никого не расстроило.

За эти годы вы построили дом, вырастили двоих замечательных детей и ни разу не дали повода усомниться, что бывает иначе. Спасибо вам за это — правда, спасибо. Вы всегда оказывались рядом ровно тогда, когда это было нужнее всего, и никогда не делали из этого события.

Отдельно хочу сказать про тот год, когда всё пошло не так и вы, не спрашивая, приехали и остались на две недели. Мы этого не забыли и не забудем. Такие вещи не возвращают, их можно только передавать дальше, и мы стараемся.

Желаем здоровья, спокойных вечеров и ещё очень многих лет вместе. Пусть дом будет полным, телефон — звонящим по хорошим поводам, а дорога до вас — короткой. Обнимаем крепко и очень скучаем.

Ваши друзья — семья Петровых`;

const sample = (n: number, name: string, message: string): PrintOrder => ({
  orderId: `sample-${n}`,
  siteId: "sample",
  orderNumber: `ОБРАЗЕЦ-${n}`,
  recipientName: name,
  recipientPhone: "+1 (424) 555-0123",
  addressLine: "12345 North Sepulveda Blvd",
  apartment: "Apt 4B",
  city: "Tarzana",
  state: "CA",
  zip: "91356",
  deliveryDate: "August 7, 2026",
  deliveryWindow: "12:00 – 15:00",
  cardMessage: message,
  hasCardMessage: true,
  siteName: "Образец",
});

const SAMPLES: PrintOrder[] = [
  sample(1, "Анна Тестова", SHORT),
  sample(2, "Мария Иванова", MEDIUM),
  sample(3, "Екатерина Смирнова", LONG),
];

export default async function PrintSamplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole("OWNER");
  const sp = await searchParams;
  const layout: PrintLayout = sp.layout === "wide" ? "wide" : "tall";
  const settings = await loadPrintSettings(layout);

  return <PrintDocument orders={SAMPLES} layout={layout} settings={settings} />;
}
