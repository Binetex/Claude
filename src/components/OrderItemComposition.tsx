/**
 * Отображение состава букета для позиции заказа. Показывает название варианта
 * (красным жирным) и снимок состава (floristCompositionSnapshot). Если состав пуст —
 * «Состав варианта не указан» (позицию не скрываем, чтобы было видно, что нужно заполнить).
 */
export function OrderItemComposition({
  variantName,
  floristComposition,
}: {
  variantName?: string | null;
  floristComposition?: string | null;
}) {
  return (
    <>
      {variantName && <div className="text-xs font-bold text-red-600">{variantName}</div>}
      <div className="mt-0.5 whitespace-pre-line text-xs text-slate-600">
        {floristComposition && floristComposition.trim() ? (
          floristComposition
        ) : (
          <span className="text-slate-400 italic">Состав варианта не указан</span>
        )}
      </div>
    </>
  );
}
