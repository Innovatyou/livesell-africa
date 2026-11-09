-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "anonymized_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "on_hand_after" INTEGER,
ADD COLUMN     "reserved_after" INTEGER;

-- AlterTable
ALTER TABLE "storefront_settings" ADD COLUMN     "order_instructions" TEXT;
