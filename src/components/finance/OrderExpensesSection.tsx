import "server-only";
/**
 * Серверная обёртка блока дополнительных расходов: одна строка на карточку заказа.
 *
 * Актора берёт из сессии сама, а не принимает пропсом: тогда страница не может передать
 * сюда чужую роль, и правило доступа остаётся одно на все три карточки.
 */
import { requireUser } from "@/lib/rbac";
import { listOrderExpenses } from "@/modules/finance/orderExpenses";
import {
  addOrderExpenseAction,
  removeOrderExpenseAction,
  updateOrderExpenseAction,
} from "@/app/dashboard/orderExpenseActions";
import { OrderExpensesCard } from "./OrderExpensesCard";

export async function OrderExpensesSection({ orderId }: { orderId: string }) {
  const user = await requireUser();
  const view = await listOrderExpenses(orderId, {
    userId: user.id,
    role: user.role,
    floristId: user.floristId,
  });

  // Тому, кто не может править, пустой блок не нужен: он ничего не сообщает.
  if (!view.canEdit && view.rows.length === 0) return null;

  return (
    <OrderExpensesCard
      orderId={orderId}
      rows={view.rows.map((r) => ({
        id: r.id,
        amountCents: r.amountCents,
        description: r.description,
        expenseDate: r.expenseDate.toISOString().slice(0, 10),
        reversedAt: r.reversedAt?.toISOString() ?? null,
        reversalReason: r.reversalReason,
        used: r.used,
      }))}
      totalCents={view.totalCents}
      canEdit={view.canEdit}
      calc={view.calc}
      actions={{
        add: addOrderExpenseAction,
        update: updateOrderExpenseAction,
        remove: removeOrderExpenseAction,
      }}
    />
  );
}
