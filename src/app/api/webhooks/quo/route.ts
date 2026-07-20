import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { featureFlags } from "@/lib/featureFlags";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { getQuoSigningKeys } from "@/integrations/quo/config";
import { intakeQuoWebhook } from "@/integrations/quo/webhookIntake";

// Единый endpoint QUO (ex-OpenPhone): messages/calls/recordings/transcripts/summaries.
// RAW тело читаем ДО JSON-парсинга (нужно для проверки подписи по сырому телу).
export const runtime = "nodejs";

export async function POST(request: Request) {
  // Мастер-выключатель QUO: при QUO_ENABLED=false интеграция полностью no-op (и приём, и отправка).
  if (!featureFlags.quo) return NextResponse.json({ disabled: true }, { status: 200 });

  const rawBody = await request.text(); // RAW body до парсинга
  const signature = request.headers.get("openphone-signature");
  const repo = new PrismaOutboxRepository(prisma);

  const res = await intakeQuoWebhook(rawBody, signature, {
    signingKeys: getQuoSigningKeys(),
    enqueue: (e) => repo.enqueue(e).then((r) => ({ created: r.created })),
  });
  return NextResponse.json(res.body, { status: res.status });
}
