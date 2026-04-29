-- AlterTable
ALTER TABLE "website_event" ADD COLUMN "device_model" VARCHAR(100);
ALTER TABLE "website_event" ADD COLUMN "device_brand" VARCHAR(50);
ALTER TABLE "website_event" ADD COLUMN "app_version" VARCHAR(50);
ALTER TABLE "website_event" ADD COLUMN "os_version" VARCHAR(50);
