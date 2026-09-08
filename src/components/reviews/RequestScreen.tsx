import "server-only";
import { REVIEW_STATUS_BADGE } from "@/lib/reviewStatus";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { OrderPageShell } from "@/components/orders/OrderPageShell";
import { OrderItemsCard } from "@/components/orders/OrderItemsCard";
import { OrderContactCards } from "@/components/orders/OrderContactCards";
import { OrderCommunications } from "@/app/dashboard/(owner)/orders/[id]/OrderCommunications";
import type { RequestDetailVM } from "@/modules/reviews/requestView";
import { RequestActions } from "./RequestActions";

/**
 * Страница одного запроса отзыва — та же раскладка и те же блоки, что у карточки заказа:
 * `OrderPageShell` (шапка, доставка, две колонки), «Товары», «Получатель/Заказчик», «Общение».
 *
 * Своей вёрстки для отзывов здесь нет намеренно. Раньше была — и владелец справедливо спросил,
 * зачем ей отличаться от уже готового и понятного экрана заказа.
 *
 * Блок общения тот же, что в карточке заказа, но лента приходит ПО НОМЕРУ заказчика: звонок из
 * QUO приходит без привязки к заказу, а разговор может идти по прошлому заказу того же человека.
 * Открывается на вкладке заказчика — отзыв просят у него.
 */
export function RequestScreen({ vm, backHref }: { vm: RequestDetailVM; backHref: string }) {
  return (
    <OrderPageShell
      backHref={backHref}
      backLabel="К списку запросов"
      orderNumber={vm.order.number}
      siteName={vm.order.siteName}
      deliveryDate={vm.order.deliveryDate}
      badges={
        <>
          <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS_BADGE[vm.status] ?? "border-slate-200 bg-slate-100 text-slate-600"}`}>
            {vm.statusText}
          </span>
          {vm.overdue && <span className="rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-900">просрочено</span>}
          {/* Статус REPLIED говорит то же самое — второй раз тем же цветом не повторяем. */}
          {vm.awaitingUs && vm.status !== "REPLIED" && (
            <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
              Клиент ответил — ход за вами
            </span>
          )}
        </>
      }
      left={
        <>
          <OrderItemsCard items={vm.order.items} showMissingCompositionHint={false} />

          <OrderContactCards
            recipient={{ name: vm.order.recipientName, phone: vm.order.recipientPhone, addressLines: vm.order.address ? [vm.order.address] : [] }}
            customer={{ name: vm.order.customerName ?? "без имени", phone: vm.order.customerPhone ?? "", email: vm.order.customerEmail }}
          />

          {/* Тот же блок, что в карточке заказа: вкладки, звонки, расшифровки, отправка SMS. */}
          <OrderCommunications
            orderId={vm.order.id}
            customerPhone={vm.order.customerPhone ?? ""}
            recipientPhone={vm.order.recipientPhone}
            storeHasQuoNumber={vm.comm.storeHasQuoNumber}
            emails={vm.emails.emails}
            customerEmail={vm.emails.customerEmail}
            communications={vm.comm.communications}
            storeTimeZone={vm.comm.storeTimeZone}
            initialSide="CUSTOMER"
          />

          <Card>
            <CardHeader className="py-2.5"><CardTitle>Что делали по запросу</CardTitle></CardHeader>
            <CardBody>
              {vm.journal.length === 0 ? (
                <p className="text-sm text-slate-500">Пока ничего.</p>
              ) : (
                <ul className="space-y-0.5 border-l border-slate-200 pl-3 text-xs">
                  {vm.journal.map((e, i) => (
                    <li key={i}>
                      <span className="font-mono text-[11px] text-slate-400">{e.at}</span>{" "}
                      <span className="text-slate-700">{e.label}</span>
                      {e.by && <span className="text-slate-400"> · {e.by}</span>}
                      {e.detail && <span className="text-slate-400"> · {e.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      }
      right={<RequestActions vm={vm} />}
    />
  );
}
