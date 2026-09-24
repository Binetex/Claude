import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { listPaymentLinks, resolvePaymentLinksAccount } from "@/modules/payments/paymentLinks";
import { PaymentLinkForm } from "./PaymentLinkForm";
import { PaymentLinkList } from "./PaymentLinkList";

export const dynamic = "force-dynamic";

/**
 * Ссылки на оплату Airwallex. Клиент просит счёт — название, сумма, готово.
 *
 * Список читается у Airwallex, своей таблицы нет: там же лежат ссылки, созданные в их кабинете,
 * и там же настоящий статус оплаты.
 */
export default async function PaymentLinksPage() {
  await requireRole("OWNER");
  const account = await resolvePaymentLinksAccount(prisma);
  const links = account ? await listPaymentLinks(prisma) : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ссылки на оплату"
        description="Название и сумма — и ссылка готова. Airwallex ничего к сумме не добавляет: налог и доставку закладывайте сами."
      />
      {account ? (
        <>
          <PaymentLinkForm accountName={account.siteName} />
          <PaymentLinkList links={links} />
        </>
      ) : (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Ключи Airwallex не настроены ни у одного магазина — создавать ссылки не из чего.
        </p>
      )}
    </div>
  );
}
