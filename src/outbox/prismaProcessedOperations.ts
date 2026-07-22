import "server-only";
/**
 * Prisma-реализация ProcessedOperationStore. Уникальность `operationKey` в БД — источник
 * истины идемпотентности: даже при гонке двух воркеров вторая вставка получит P2002 и
 * трактуется как «уже выполнено» (действие не повторяется).
 */
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import type { ProcessedOperationStore, ProcessedOperationRecord } from "./idempotency";

export class PrismaProcessedOperationStore implements ProcessedOperationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async wasProcessed(operationKey: string): Promise<ProcessedOperationRecord> {
    const row = await this.prisma.processedOperation.findUnique({ where: { operationKey } });
    return row ? { processed: true, externalId: row.externalId } : { processed: false, externalId: null };
  }

  async markProcessed(operationKey: string, kind: string, externalId: string | null = null): Promise<void> {
    try {
      await this.prisma.processedOperation.create({ data: { operationKey, kind, externalId } });
    } catch (err) {
      // Гонка: ключ уже зафиксирован другим воркером — это ожидаемо и безопасно.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
      throw err;
    }
  }
}
