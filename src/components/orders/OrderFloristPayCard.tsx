import { Card, CardBody } from "@/components/ui/Card";
import { OrderPriceCard } from "./OrderPriceCard";

/**
 * Чем оплачивается ЭТОТ заказ флористу — плашка в колонке управления у владельца.
 *
 * Раньше здесь безусловно стояла «Цена флориста» с суммой `Order.floristTotal`. Для
 * основного флориста (PRIMARY) это число не значит ничего: его заработок — доля от прибыли
 * ДНЯ (`balance.ts::primaryEarned`), а сама прибыль дня `floristTotal` даже не вычитает
 * (`dayCalc.ts::computeOrderContribution`). Владелец видел сумму, которая ни на что не
 * влияет, и правил её карандашом с тем же результатом. Поэтому у PRIMARY плашки нет —
 * ни с суммой, ни с объяснением вместо суммы.
 *
 * Условие — МОДЕЛЬ профиля на дату доставки, а НЕ `Florist.financeVisibility`. Вторая про
 * то, какие суммы видит сам флорист, и переключается отдельным тумблером; сегодня они
 * совпадают только из-за дефолта при создании пользователя. Завязка на неё была бы верной
 * по совпадению и молча сломалась бы при первом же переключении.
 */
export type FloristPayView =
  /** Фиксированная цена заказа — это и есть заработок второстепенного флориста. */
  | { model: "SECONDARY"; floristTotal: number; priceMode: "AUTO" | "MANUAL" }
  /** Доля от прибыли дня. Суммы по одному заказу не существует. */
  | { model: "PRIMARY"; sharePercentBp: number | null }
  /** Профиля на дату доставки нет — считать заказ нечем. */
  | { model: null };

export function OrderFloristPayCard({
  pay,
  priceAction,
}: {
  pay: FloristPayView;
  /** Правка ручной цены. Рендерится только у SECONDARY: у остальных ей нечего менять. */
  priceAction?: React.ReactNode;
}) {
  if (pay.model === "SECONDARY") {
    return (
      <OrderPriceCard
        label="Цена флориста"
        amount={pay.floristTotal}
        hint={pay.priceMode === "MANUAL" ? "задана вручную" : "авто-цена"}
        action={priceAction}
      />
    );
  }

  // PRIMARY — плашки нет вовсе. Сумма по заказу для него не существует, а блок «доля 66,6%,
  // отдельной суммы нет» ничего не сообщал бы: доля одна и та же на всех заказах, читать её
  // на каждой карточке незачем. Она живёт в профиле флориста и в разборе дней.
  if (pay.model === "PRIMARY") return null;

  return (
    <Card className="border-amber-200 bg-amber-50">
      <CardBody className="px-4 py-3">
        <div className="text-xs font-semibold text-amber-800">Финансовый профиль не задан</div>
        <p className="mt-0.5 text-[11px] text-amber-700">
          На дату доставки у флориста нет действующего профиля, поэтому заказ ни во что не считается.
        </p>
      </CardBody>
    </Card>
  );
}
