-- add mobile-specific columns to website_event table
ALTER TABLE umami.website_event ADD COLUMN "device_model" String AFTER "distinct_id";
ALTER TABLE umami.website_event ADD COLUMN "device_brand" String AFTER "device_model";
ALTER TABLE umami.website_event ADD COLUMN "os_version" String AFTER "device_brand";
ALTER TABLE umami.website_event ADD COLUMN "app_version" String AFTER "os_version";
