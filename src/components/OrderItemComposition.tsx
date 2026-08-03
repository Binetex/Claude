/**
 * Отображение состава букета для позиции заказа. Показывает название варианта
 * (красным жирным) и снимок состава (floristCompositionSnapshot).
 *
 * Пустой состав по умолчанию подписывается «Состав варианта не указан» — владельцу и
 * колл-центру это сигнал, что каталог надо дозаполнить. Флористу такой сигнал не адресован:
 * сделать он с ним ничего не может, а строка повторяется у каждой позиции, поэтому там
 * подсказка выключается (showMissingHint=false) и место просто остаётся пустым.
 */
export function OrderItemComposition({
  variantName,
  floristComposition,
  showMissingHint = true,
}: {
  variantName?: string | null;
  floristComposition?: string | null;
  showMissingHint?: boolean;
}) {
  const composition = floristComposition?.trim() ? floristComposition : null;
  if (!composition && !showMissingHint && !variantName) return null;

  return (
    <>
      {variantName && <div className="text-xs font-bold text-red-600">{variantName}</div>}
      {(composition || showMissingHint) && (
        <div className="mt-0.5 whitespace-pre-line text-xs text-slate-600">
          {composition ?? <span className="text-slate-400 italic">Состав варианта не указан</span>}
        </div>
      )}
    </>
  );
}
