-- Два состояния, которых не хватало между «ссылка отправлена» и «закрыли»:
--  IGNORING — ссылка у клиента больше суток, и от него ни слова;
--  REPLIED  — клиент ответил, и ход снова за нами.
-- Только добавление значений в enum: старый код продолжает работать во время деплоя, потому что
-- этих значений в данных ещё нет.
ALTER TYPE "ReviewRequestStatus" ADD VALUE IF NOT EXISTS 'IGNORING';
ALTER TYPE "ReviewRequestStatus" ADD VALUE IF NOT EXISTS 'REPLIED';

-- Журнал запроса пополняется, а не переписывается: у обоих переходов своя строка.
ALTER TYPE "ReviewEventKind" ADD VALUE IF NOT EXISTS 'IGNORED';
ALTER TYPE "ReviewEventKind" ADD VALUE IF NOT EXISTS 'REPLIED';
