import { NextResponse } from "next/server";
import { isHeartbeatStale, maxAgeMsFromEnv, readHeartbeat } from "@/outbox/heartbeat";

/**
 * Живость outbox-воркера для внешнего монитора. ОТДЕЛЬНО от `/api/health` сознательно:
 * тот эндпоинт — гейт успешного деплоя в `deploy.sh` и проверка самого веб-процесса, и если
 * бы он падал из-за воркера, мёртвый воркер откатывал бы деплои и мог увести сайт в maintenance.
 * Здесь наоборот: 503 — это и есть сигнал «воркер не тикает, разберитесь».
 *
 * Авторизации нет и данных не отдаёт — только id воркера и возраст отметки, как `/api/health`.
 */
export async function GET() {
  const beat = await readHeartbeat();
  const now = new Date();

  if (!beat) {
    // Отметки нет вовсе: воркер не запускался с момента появления этой проверки, либо не
    // может писать в logs/. И то и другое означает «фоновая работа не идёт».
    return NextResponse.json({ status: "error", worker: "no_heartbeat" }, { status: 503 });
  }

  const tickAt = new Date(beat.tickAt);
  const ageMs = now.getTime() - tickAt.getTime();
  const stale = isHeartbeatStale(tickAt, now, maxAgeMsFromEnv());

  return NextResponse.json(
    {
      status: stale ? "error" : "ok",
      worker: stale ? "stale" : "alive",
      workerId: beat.workerId,
      tickAt: beat.tickAt,
      ageMs,
    },
    { status: stale ? 503 : 200 }
  );
}
