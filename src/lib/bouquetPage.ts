/**
 * Публичная ссылка на страницу с фото букета — для клиента.
 *
 * Само фото клиенту уходит картинкой (MMS) браузером Quo; эта страница — запасной путь, когда
 * браузера нет: через API Quo картинку не отправить, и вместо неё уходит ссылка сюда.
 * Токен страницы — имя файла: оно у нас `randomUUID`, то есть неугадываемое, и отдельной
 * колонки под «публичный токен» не нужно. Сама картинка и так отдаётся по этому имени через
 * /api/media — страница добавляет только подпись магазина и человеческий вид.
 */
import { getAppUrl } from "./appUrl";

const MEDIA_PREFIX = "/api/media/";

/** Имя файла из внутренней ссылки на фото, или null, если ссылка не наша. */
export function bouquetMediaName(mediaUrl: string | null | undefined): string | null {
  if (!mediaUrl) return null;
  const path = mediaUrl.replace(/^https?:\/\/[^/]+/, "");
  if (!path.startsWith(MEDIA_PREFIX)) return null;
  const name = path.slice(MEDIA_PREFIX.length);
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..") ? name : null;
}

/** Абсолютная ссылка на страницу фото — то, что уходит клиенту. */
export function bouquetPageUrl(mediaUrl: string | null | undefined): string | null {
  const name = bouquetMediaName(mediaUrl);
  return name ? `${getAppUrl()}/bouquet/${name}` : null;
}
