-- Доля флориста от цены букета на сайте (владелец 10.10.2026: новый флорист Арина получает 60%
-- от цены букета, а не цену из каталога, как Ольга). Колонка только добавляется и пустая у всех:
-- старый код в окне деплоя её не читает, а пустое значение означает «цена из каталога, как раньше».
ALTER TABLE "Florist" ADD COLUMN "bouquetSharePercentBp" INTEGER;

ALTER TABLE "Florist" ADD CONSTRAINT "Florist_bouquetSharePercentBp_check"
    CHECK ("bouquetSharePercentBp" IS NULL OR ("bouquetSharePercentBp" BETWEEN 1 AND 10000));
