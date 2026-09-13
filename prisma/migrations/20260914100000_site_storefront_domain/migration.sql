-- Публичный домен витрины магазина (paradiseflowersart.com), а не служебный *.myshopify.com.
-- Нужен ассистенту: ссылку на товар видит клиент, и внутренний домен в SMS выглядит подделкой.
ALTER TABLE "Site" ADD COLUMN "storefrontDomain" TEXT;
