import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * Health-эндпоинт для Nginx/аптайм-мониторинга и PM2.
 * Не требует авторизации, не отдаёт чувствительных данных.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "error", db: "unreachable" }, { status: 503 });
  }
}
