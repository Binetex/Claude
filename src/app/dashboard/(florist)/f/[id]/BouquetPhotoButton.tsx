"use client";
import { useRef, useState, useTransition } from "react";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/ImageLightbox";
import { compressImage } from "@/lib/imageCompress";
import { floristUploadBouquetPhoto } from "@/app/dashboard/(florist)/actions";

/**
 * Фото готового букета внутри блока доставки.
 *
 * Раньше загрузка жила внутри кнопки «Готово» и вместе с ней меняла статус. Теперь это
 * самостоятельное действие: статус флорист ставит сам, а фото приложить можно в любой
 * момент — в том числе после того, как заказ уже отмечен готовым.
 */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i;

/** Тип браузер иногда не сообщает (HEIC с айфона), поэтому расширение — второй признак. */
export function looksLikeImage(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

export function BouquetPhotoButton({ orderId, photoUrl }: { orderId: string; photoUrl: string | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(photoUrl);
  const [pending, start] = useTransition();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ""; // одно и то же фото можно выбрать повторно
    // Из «Файлов» на телефоне можно выбрать что угодно, включая PDF и видео. Сказать об этом
    // сразу понятнее, чем уронить обработку картинки и показать «не удалось загрузить».
    //
    // Смотрим и на расширение: у HEIC с айфона браузер нередко отдаёт ПУСТОЙ тип, и проверка
    // по одному только `file.type` отсекала бы нормальную фотографию словами «это не
    // изображение» — самая обидная разновидность ошибки, когда система врёт про исправное.
    if (!looksLikeImage(file)) {
      toast.error("Это не изображение — выберите фотографию.");
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = await compressImage(file);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось обработать фото");
      return;
    }
    setPreview(dataUrl); // показываем сразу, не дожидаясь загрузки
    start(async () => {
      const res = await floristUploadBouquetPhoto(orderId, dataUrl);
      if (res.ok) toast.success("Фото букета сохранено");
      else {
        setPreview(photoUrl);
        toast.error(res.error ?? "Не удалось сохранить фото");
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.heic,.heif"
        // Атрибута `capture` здесь БЫТЬ НЕ ДОЛЖНО: он заставляет телефон открывать камеру сразу,
        // минуя выбор источника, — и снять букет заново было единственным способом приложить
        // фото. Без него телефон сам предлагает камеру, галерею и файлы.
        onChange={onPick}
        className="hidden"
        aria-hidden
        tabIndex={-1}
      />
      {preview && <ZoomableImage src={preview} alt="Фото букета" className="size-16 rounded-lg object-cover" />}
      <Button variant="outline" size="sm" disabled={pending} onClick={() => fileRef.current?.click()}>
        <Camera className="size-4" />
        {pending ? "Сохранение…" : preview ? "Заменить фото букета" : "Фото букета"}
      </Button>
    </div>
  );
}
