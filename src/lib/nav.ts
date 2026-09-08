import "server-only";
import { prisma } from "@/lib/db";
import type { CurrentUser } from "@/lib/auth";
import type { NavItem } from "@/components/AppShell";

/**
 * Меню кабинета — ОДНО на все страницы роли, включая общие сегменты вне role-групп
 * (/dashboard/burq, /dashboard/communications).
 *
 * Раньше каждый layout объявлял свой массив, и у общих сегментов он состоял из двух строк:
 * «← Заказы» и сам раздел. Клик по «Доставка (Burq)» стирал меню из двенадцати пунктов до
 * двух — человек оказывался будто в другой системе и возвращался кнопкой «назад».
 *
 * Асинхронная: у флориста состав пунктов зависит от его финансового профиля.
 */
export async function navFor(user: CurrentUser): Promise<NavItem[]> {
  switch (user.role) {
    case "OWNER":
      return ownerNav();
    case "CALL_CENTER":
      return callCenterNav();
    case "FLORIST":
      return floristNav(user);
  }
}

/**
 * Одиннадцать пунктов, порядок — по частоте работы: сверху то, куда заходят каждый день.
 *
 * Всё редкое и настроечное собрано в один пункт «Настройки» с вкладками внутри — тем же
 * приёмом, что уже применён к «Финансам» (пять пунктов вперемешку с заказами топили и то и
 * другое). Многоуровневых раскрывающихся меню в сайдбаре нет и не будет: второй уровень —
 * только вкладки внутри страницы.
 */
function ownerNav(): NavItem[] {
  return [
    { href: "/dashboard/orders", label: "Заказы" },
    // Ведём сразу на «Запросы»: /dashboard/reviews — редирект на них же, и клик по пункту
    // прогонял layout раздела дважды. Подсветка по всему разделу держится на match.
    { href: "/dashboard/reviews/requests", label: "Отзывы", match: ["/dashboard/reviews"] },
    // Отдельным пунктом, а не вкладкой «Настроек»: это не настройка, а работа — входящие от
    // людей, у которых ещё нет заказа (≈1400 звонков и SMS в месяц, из них живой спрос).
    { href: "/dashboard/communications", label: "Другие сообщения" },
    // Один пункт на весь раздел: подстраницы живут во вкладках внутри (finance/layout.tsx).
    { href: "/dashboard/finance", label: "Финансы" },
    // Отдельно от «Финансов»: там расчёты с флористами, здесь — расходы самого бизнеса.
    { href: "/dashboard/expenses", label: "Мои расходы" },
    { href: "/dashboard/products", label: "Товары" },
    // Ведётся каждый день, поэтому в меню, а не во вкладке «Настроек».
    { href: "/dashboard/consumables", label: "Расходники" },
    { href: "/dashboard/florists", label: "Флористы" },
    { href: "/dashboard/sites", label: "Магазины" },
    { href: "/dashboard/automations", label: "Автоматизации" },
    {
      // Как и «Отзывы» — сразу на первую вкладку, минуя редирект с корня раздела.
      href: "/dashboard/settings/users",
      label: "Настройки",
      // Burq лежит вне группы (owner) — иначе на него навесится requireRole("OWNER") и
      // раздел закроется для остальных ролей, ради которых его и вынесли. Поэтому пункт
      // подсвечивается и на его адресе тоже.
      match: ["/dashboard/settings", "/dashboard/burq"],
    },
  ];
}

function callCenterNav(): NavItem[] {
  return [
    { href: "/dashboard/cc", label: "Заказы" },
    { href: "/dashboard/cc/reviews", label: "Отзывы" },
    // Разбирать входящие от новых людей — работа колл-центра, а не владельца.
    { href: "/dashboard/communications", label: "Другие сообщения" },
  ];
}

async function floristNav(user: CurrentUser): Promise<NavItem[]> {
  // Пункт «Расходы на цветы» появляется только у основного флориста: дневная закупка
  // существует лишь у PRIMARY-профиля, и показывать остальным пункт, ведущий в отказ, —
  // значит обещать раздел, которого у них нет.
  //
  // Без floristId (профиль ещё не привязан) запрос не делаем вовсе: requireFlorist в таком
  // случае уводит на /login, и лишний поход в базу на каждой странице ни к чему.
  const primary = user.floristId
    ? await prisma.floristFinanceProfile.findFirst({
        where: { floristId: user.floristId, model: "PRIMARY", active: true, effectiveTo: null },
        select: { id: true },
      })
    : null;

  return [
    { href: "/dashboard/f", label: "Мои заказы" },
    { href: "/dashboard/f/finance", label: "Мои финансы" },
    ...(primary ? [{ href: "/dashboard/f/flower-expenses", label: "Расходы на цветы" }] : []),
    { href: "/dashboard/f/pickup", label: "Мои точки забора" },
    { href: "/dashboard/f/print-notes", label: "Печать записок" },
  ];
}
