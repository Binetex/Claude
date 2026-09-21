-- Аватарка сотрудника: ссылка на файл, сам файл на диске (public/uploads, отдаётся /api/media).
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
