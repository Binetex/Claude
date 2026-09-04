import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { bouquetMediaName } from "@/lib/bouquetPage";

/** Заголовок вкладки и превью ссылки в SMS — клиенту, по-английски, без имени дашборда. */
export const metadata: Metadata = { title: "Your bouquet", robots: { index: false, follow: false } };

/**
 * Публичная страница с фото букета — по ссылке из SMS клиенту.
 *
 * Без входа и без базы: имя файла неугадываемое (randomUUID), а сама картинка уже отдаётся по
 * нему через /api/media. Страница нужна ради человеческого вида в SMS-превью и подписи, а не
 * ради защиты. Ни номера заказа, ни имён здесь нет: ссылку могут переслать.
 */
export const dynamic = "force-dynamic";

export default async function BouquetPhotoPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const safe = bouquetMediaName(`/api/media/${name}`);
  if (!safe) notFound();

  return (
    <main
      // Корневой layout — интерфейс дашборда на русском; эта страница для клиента.
      lang="en"
      style={{
        minHeight: "100vh", margin: 0, padding: "24px 16px", background: "#f6f7f9",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", color: "#191d23",
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Your bouquet</h1>
      {/* eslint-disable-next-line @next/next/no-img-element -- runtime-uploaded file, no static optimization */}
      <img
        src={`/api/media/${safe}`}
        alt="Photo of the bouquet"
        style={{ maxWidth: "100%", width: 640, borderRadius: 12, boxShadow: "0 2px 12px rgba(0,0,0,.12)" }}
      />
      <p style={{ fontSize: 13, color: "#5b6672", margin: 0 }}>Made with care by our florists.</p>
    </main>
  );
}
