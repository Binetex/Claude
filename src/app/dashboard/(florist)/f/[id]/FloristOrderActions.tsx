"use client";
import { useRef, useState, useTransition } from "react";
import {
  floristStartWork,
  floristMarkReady,
  floristSetReadyTime,
} from "@/app/dashboard/(florist)/actions";
import { FloristHandoff } from "../FloristHandoff";
import type { OrderStatus } from "@/generated/prisma/enums";

const bigBtn = "w-full rounded-xl px-4 py-3.5 text-base font-semibold disabled:opacity-60";
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

/**
 * Сжимает фото с телефона перед отправкой server action'ом: без этого data URL
 * оригинального снимка (часто 3-8MB) упирается в лимит размера тела запроса Next.js
 * (по умолчанию 1MB) — именно это и вызывало ошибку при "Готово + фото". Уменьшаем
 * до разумного размера и перекодируем в JPEG — для отображения в дашборде этого
 * достаточно, а запрос всегда укладывается в лимит.
 */
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Не удалось загрузить изображение"));
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas недоступен"));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function FloristOrderActions({
  orderId,
  orderStatus,
  florists,
}: {
  orderId: string;
  orderStatus: OrderStatus;
  florists: { id: string; name: string }[];
}) {
  const [pending, start] = useTransition();
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [readyTime, setReadyTime] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError(null);
    try {
      setPhoto(await compressImage(file));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Не удалось обработать фото, попробуйте другое");
    }
  }

  // Назначен и авто-принят (FLORIST_ACCEPTED) или легаси ASSIGNED → начать работу либо передать другому.
  if (orderStatus === "ASSIGNED" || orderStatus === "FLORIST_ACCEPTED") {
    return (
      <div className="grid grid-cols-2 gap-3">
        <button disabled={pending} onClick={() => start(() => floristStartWork(orderId))} className={`${bigBtn} bg-slate-800 text-white hover:bg-slate-900`}>
          Начать работу
        </button>
        <FloristHandoff orderId={orderId} florists={florists} btnClass={`${bigBtn} border border-red-300 bg-white text-red-600 hover:bg-red-50`} />
      </div>
    );
  }

  // В работе → время готовности, фото, готово
  if (orderStatus === "IN_PROGRESS") {
    return (
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            type="datetime-local"
            value={readyTime}
            onChange={(e) => setReadyTime(e.target.value)}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            disabled={pending || !readyTime}
            onClick={() => start(() => floristSetReadyTime(orderId, new Date(readyTime).toISOString()))}
            className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            Время готовности
          </button>
        </div>

        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPickFile} className="hidden" />
        {photoError && <p className="text-sm text-red-600">{photoError}</p>}
        {photo ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt="Предпросмотр" className="h-48 w-full rounded-lg object-cover" />
            <button onClick={() => fileRef.current?.click()} className="w-full rounded-lg border border-slate-300 py-2 text-sm">
              Заменить фото
            </button>
          </div>
        ) : (
          <button onClick={() => fileRef.current?.click()} className="w-full rounded-lg border border-slate-300 py-3 text-sm font-medium text-slate-600">
            📷 Загрузить фото букета
          </button>
        )}

        <button
          disabled={pending}
          onClick={() => start(() => floristMarkReady(orderId, photo ?? undefined))}
          className={`${bigBtn} bg-emerald-600 text-white hover:bg-emerald-700`}
        >
          Готово {photo ? "(с фото)" : "(без фото)"}
        </button>
      </div>
    );
  }

  // Готов и далее — работа флориста завершена
  return (
    <div className="rounded-lg bg-emerald-50 px-4 py-3 text-center text-sm font-medium text-emerald-700">
      Заказ готов ✓
    </div>
  );
}
