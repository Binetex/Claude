import "server-only";
/**
 * Общее правило ассистента — одно на все магазины.
 *
 * «Сегодня выходной», «заказы принимаем со вторника», «доставки только после 14:00»: такое
 * случается разом во всех магазинах, и переписывать базу знаний каждому в этот момент никто не
 * станет. Правило кладётся в запрос ВЫШЕ баз знаний и объявлено сильнее их, а пока оно
 * действует, заготовки на частые вопросы не применяются вовсе: «привезём сегодня в 11» из
 * заготовки прямо противоречило бы «сегодня не работаем».
 *
 * Срок действия — последний день включительно, по календарю магазина. Пусто значит «пока не
 * сотру», и это опасное значение: забытое «сегодня выходной» будет неделю отвечать клиентам
 * неправдой. Поэтому интерфейс показывает, сколько правило уже висит, а по умолчанию
 * предлагает сегодняшний день.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";

const SINGLETON = "singleton";

/** Правило длиннее этого в запрос не поместится осмысленно — и писать роман сюда не надо. */
export const GLOBAL_NOTE_MAX = 1000;

export type GlobalNote = {
  text: string | null;
  /** Последний день действия (UTC-полночь локального дня) либо null — бессрочно. */
  activeUntil: Date | null;
  updatedAt: Date | null;
};

/** Действует ли правило на указанный день магазина. Чистая функция: её проверяет тест. */
export function isGlobalNoteActive(note: GlobalNote | null, todayStr: string): boolean {
  if (!note?.text?.trim()) return false;
  if (!note.activeUntil) return true;
  return todayStr <= note.activeUntil.toISOString().slice(0, 10);
}

/** Текст правила, если оно действует прямо сейчас; иначе null. */
export function activeGlobalNoteText(note: GlobalNote | null, now: Date, tz: string | null): string | null {
  return isGlobalNoteActive(note, todayStrInTz(tz ?? DEFAULT_STORE_TZ, now)) ? note!.text!.trim() : null;
}

export async function loadGlobalNote(prisma: PrismaClient): Promise<GlobalNote> {
  const row = await prisma.aiAssistantSettings.findUnique({ where: { id: SINGLETON } });
  return { text: row?.globalNote ?? null, activeUntil: row?.activeUntil ?? null, updatedAt: row?.updatedAt ?? null };
}

export async function saveGlobalNote(
  prisma: PrismaClient,
  input: { text: string | null; activeUntil: Date | null; userId: string }
): Promise<void> {
  const text = input.text?.trim() ? input.text.trim().slice(0, GLOBAL_NOTE_MAX) : null;
  // Пустой текст стирает и срок: «правило снято» — это одно состояние, а не два.
  const activeUntil = text ? input.activeUntil : null;
  await prisma.aiAssistantSettings.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, globalNote: text, activeUntil, updatedByUserId: input.userId },
    update: { globalNote: text, activeUntil, updatedByUserId: input.userId },
  });
}
