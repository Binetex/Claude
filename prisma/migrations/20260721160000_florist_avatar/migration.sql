-- Маленькая аватарка флориста (ссылка на файл в public/uploads; сам файл в БД не хранится).
ALTER TABLE "Florist" ADD COLUMN "avatarUrl" TEXT;
