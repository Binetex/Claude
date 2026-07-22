import { ZoomableImage } from "@/components/ImageLightbox";

/**
 * Фото позиции ВНУТРИ страницы конкретного заказа: основное (родительское) и, дополнительно,
 * фото выбранной вариации. Дедупликация уже сделана в getOrderItemImages — сюда variantImage
 * приходит только если оно есть и отличается от основного. В общих списках компонент не
 * используется: там показывается одно основное фото.
 */
export function OrderItemImages({
  image,
  variantImage,
  size = "h-14 w-14",
}: {
  image: string | null;
  variantImage: string | null;
  size?: string;
}) {
  if (!image && !variantImage) return null;
  return (
    <div className="flex shrink-0 items-start gap-1.5">
      {image && <ZoomableImage src={image} alt="Фото товара" className={`${size} rounded-lg object-cover`} />}
      {variantImage && (
        <span className="flex flex-col items-center gap-0.5">
          <ZoomableImage src={variantImage} alt="Фото выбранной вариации" className={`${size} rounded-lg object-cover ring-1 ring-slate-200`} />
          <span className="text-[10px] leading-none text-slate-400">вариация</span>
        </span>
      )}
    </div>
  );
}
