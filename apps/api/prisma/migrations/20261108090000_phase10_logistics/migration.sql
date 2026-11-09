-- AlterTable
ALTER TABLE "delivery_orders" ADD COLUMN     "carrier_name" TEXT,
ADD COLUMN     "problem_note" TEXT;

-- AlterTable
ALTER TABLE "delivery_zones" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "storefront_settings" ADD COLUMN     "delivery_settings" JSONB NOT NULL DEFAULT '{}';

-- AddForeignKey
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "delivery_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Money and timing sanity (application validates first; these are the backstop).
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_fee_minor_check" CHECK ("fee_minor" >= 0);
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_eta_days_check" CHECK ("eta_days" IS NULL OR "eta_days" BETWEEN 0 AND 60);
