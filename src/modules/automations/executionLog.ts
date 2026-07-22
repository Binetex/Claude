import "server-only";
/**
 * Журнал выполнения job'ов автоматизаций — только для РЕАЛЬНО созданных Job. Best-effort:
 * сбой логирования НЕ ломает исполнение. Без секретов/PII — только безопасная деталь.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type ExecStage = "scheduled" | "picked" | "rendered" | "provider_accepted" | "sent" | "skipped" | "failed";

export async function logExecution(
  prisma: PrismaClient,
  args: { jobId: string; automationId: string; orderId?: string | null; stage: ExecStage; detailSafe?: string | null }
): Promise<void> {
  try {
    await prisma.automationExecutionLog.create({
      data: {
        jobId: args.jobId,
        automationId: args.automationId,
        orderId: args.orderId ?? null,
        stage: args.stage,
        detailSafe: args.detailSafe ?? null,
      },
    });
  } catch (err) {
    console.error(`[automations] execution log (${args.stage}) failed for job ${args.jobId}:`, err instanceof Error ? err.message : String(err));
  }
}
