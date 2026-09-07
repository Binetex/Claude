import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/rbac";
import { listBots } from "@/integrations/telegram/bots";
import { loadTelegramGlobalView } from "@/integrations/telegram/settings";
import { listTelegramEvents } from "@/integrations/telegram/registry";
import { getRepliesStatusMap } from "@/integrations/telegram/replies";
import { Card, CardBody } from "@/components/ui/Card";
import { TelegramBotsPanel } from "./TelegramBotsPanel";

export const dynamic = "force-dynamic";

/** Кому уходит уведомление — подпись и цвет. Адресатов три, тернарником их не разложить. */
const AUDIENCE_META: Record<string, { label: string; className: string }> = {
  OWNER: { label: "владельцу", className: "border-sky-200 bg-sky-50 text-sky-700" },
  FLORIST: { label: "флористу", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  CUSTOMER_SERVICE: { label: "колл-центру", className: "border-amber-200 bg-amber-50 text-amber-800" },
};

export default async function TelegramSettingsPage() {
  await requireRole("OWNER");
  const [global, bots, florists] = await Promise.all([
    loadTelegramGlobalView(prisma),
    listBots(prisma),
    prisma.florist.findMany({
      where: { active: true },
      select: { id: true, user: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  // Состояние приёма спрашиваем у Telegram, а не у своей БД: см. integrations/telegram/replies.ts.
  const replies = await getRepliesStatusMap(prisma, bots.filter((b) => b.tokenConfigured).map((b) => b.id));
  // Рядом с каждым событием видно, дойдёт ли оно сейчас: иначе настройка «кому писать» выше
  // выглядит как галочка без последствий, и непонятно, что именно она гасит. Наборов два —
  // события ассистента смотрят на свой.
  const flags = (a: { owner: boolean; florists: boolean; customerService: boolean }): Record<string, boolean> => ({
    OWNER: a.owner,
    FLORIST: a.florists,
    CUSTOMER_SERVICE: a.customerService,
  });
  const systemOn = flags(global.audiences);
  const aiOn = flags(global.aiAudiences);
  const events = listTelegramEvents().map((e) => ({
    type: e.type,
    audience: e.audience,
    description: e.description,
    fromAssistant: !!e.fromAssistant,
    on: (e.fromAssistant ? aiOn : systemOn)[e.audience],
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800">Telegram-уведомления</h1>
        <p className="text-sm text-slate-500">
          У владельца свой бот, у каждого флориста — свой. Токены хранятся зашифрованными и обратно не показываются.
          Включить бота можно только после успешной проверки.
        </p>
      </div>

      <TelegramBotsPanel
        global={global}
        bots={bots}
        replies={replies}
        florists={florists.map((f) => ({ id: f.id, name: f.user.name }))}
      />

      <Card>
        <CardBody className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-800">Какие события отправляются</h2>
          <ul className="space-y-1 text-xs text-slate-600">
            {events.map((e) => (
              <li key={e.type} className={`flex gap-2 ${e.on ? "" : "opacity-50"}`}>
                <span className={`shrink-0 rounded border px-1.5 py-px text-[11px] ${AUDIENCE_META[e.audience].className}`}>
                  {AUDIENCE_META[e.audience].label}
                </span>
                <span>
                  {e.fromAssistant && (
                    <span className="mr-1 rounded border border-violet-200 bg-violet-50 px-1 py-px text-[11px] text-violet-700">ИИ</span>
                  )}
                  <code className="rounded bg-slate-100 px-1">{e.type}</code> — {e.description}
                  {!e.on && <span className="text-amber-700"> Сейчас не отправляется.</span>}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
