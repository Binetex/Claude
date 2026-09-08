import "server-only";
import Link from "next/link";
import { format } from "date-fns";
import { AlertTriangle } from "lucide-react";
import { prisma } from "@/lib/db";
import { loadQuoBalanceAlert } from "@/integrations/quo/balanceAlert";

/**
 * «У QUO закончились деньги» — красная полоса на главной странице владельца.
 *
 * Пустой баланс останавливает ВСЮ переписку с клиентами: ответы ассистента, уведомления о
 * доставке, ссылки на отзывы. Молчание при этом выглядит как обычный спокойный день — ровно
 * поэтому 7 сентября владелец узнал о пустом балансе случайно, нажав «Отправить» на черновике.
 *
 * Гаснет сам: как только хоть одна SMS уйдёт, состояние «денег нет» перестанет выводиться из
 * записей об отправках. Кнопки «я оплатил» нет и не нужно — она врала бы при первой ошибке.
 */
export async function QuoBalanceBanner() {
  const alert = await loadQuoBalanceAlert(prisma).catch(() => null);
  if (!alert) return null;

  // Тот же формат, что в журналах дашборда: «07.09 15:37».
  const since = format(alert.at, "dd.MM HH:mm");
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3">
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-red-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-red-900">QUO: закончились деньги — SMS клиентам не уходят</div>
          <p className="mt-1 text-sm text-red-800">
            С {since} QUO отклоняет отправку с кодом 402 (нет средств на аккаунте). Не уходят ни
            ответы ассистента, ни уведомления о доставке, ни ссылки на отзывы. Пополните баланс
            QUO — полоса погаснет сама, как только уйдёт первое сообщение.
          </p>
          <Link href="/dashboard/settings/system-events" className="mt-1 inline-block text-xs text-red-700 underline">
            Системные события
          </Link>
        </div>
      </div>
    </div>
  );
}
