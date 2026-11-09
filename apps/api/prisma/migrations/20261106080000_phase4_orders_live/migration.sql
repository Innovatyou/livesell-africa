-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "product_code" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "stock_committed_at" TIMESTAMP(3),
ADD COLUMN     "tracking_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_tracking_token_hash_key" ON "orders"("tracking_token_hash");

