/**
 * Сжатие фото с телефона перед отправкой server action'ом.
 *
 * ВАЖНОЕ СЛЕДСТВИЕ: наружу всегда уходит JPEG, каким бы ни был исходник. Рисование в canvas и
 * `toDataURL("image/jpeg")` перекодируют всё, что браузер сумел показать, — поэтому в хранилище
 * HEIC не попадает никогда, и картинка везде дальше (карточка, письмо, сообщение клиенту)
 * открывается на любом устройстве.
 *
 * Обратная сторона: формат, который браузер рисовать НЕ умеет, сюда не пройдёт вовсе. HEIC
 * умеют Safari на iOS и macOS; Chrome и Android — нет, и там фотография отклоняется с
 * объяснением, а не сохраняется в виде, который потом никто не откроет.
 *
 * Без этого data URL оригинального снимка (часто 3–8 МБ) упирается в лимит размера тела
 * запроса Next.js (по умолчанию 1 МБ) — именно это и вызывало ошибку при отправке фото
 * букета. Уменьшаем до разумного размера и перекодируем в JPEG: для показа в дашборде
 * этого достаточно, а запрос всегда укладывается в лимит.
 *
 * Только браузер: использует FileReader, Image и canvas.
 */
const MAX_DIMENSION = 1600;

function isHeic(file: File): boolean {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}
const JPEG_QUALITY = 0.8;

export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      // Формат, который браузер не умеет рисовать (HEIC на Android, RAW, битый файл). Айфон
      // при выборе из библиотеки отдаёт JPEG сам, но из «Файлов» может прийти что угодно.
      img.onerror = () =>
        reject(
          new Error(
            isHeic(file)
              ? "Формат HEIC этот браузер не открывает. Снимите фото прямо здесь или сохраните его как JPEG."
              : "Этот формат фото не поддерживается — попробуйте JPEG или PNG"
          )
        );
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
