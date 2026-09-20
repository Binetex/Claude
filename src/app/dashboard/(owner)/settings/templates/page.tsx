import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui/misc";
import { SMS_VARIABLES } from "@/modules/messaging/variables";
import { TemplatesEditor } from "./TemplatesEditor";

export const dynamic = "force-dynamic";

/**
 * Заготовки ответов клиенту. Один список на все магазины: одни и те же слова про вазу,
 * апартаменты и отзыв владелец пишет в любой переписке, и пять копий одного текста
 * разъехались бы в пяти магазинах.
 *
 * Сами тексты правит только владелец — вставлять их может любой, кто отвечает клиенту.
 */
export default async function MessageTemplatesPage() {
  await requireRole("OWNER");
  const templates = await prisma.messageTemplate.findMany({
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, text: true, active: true },
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Заготовки ответов"
        description="Кнопки над полем сообщения в карточке заказа. Нажатие вставляет текст в поле — отправляет его человек, поэтому заготовку всегда можно дописать под случай."
      />
      <TemplatesEditor templates={templates} variables={SMS_VARIABLES.map((v) => ({ key: v.key, label: v.label }))} />
    </div>
  );
}
