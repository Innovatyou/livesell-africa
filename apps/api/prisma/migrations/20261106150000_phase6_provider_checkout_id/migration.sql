-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN     "provider_checkout_id" TEXT;

-- CreateIndex
CREATE INDEX "payment_transactions_provider_provider_checkout_id_idx" ON "payment_transactions"("provider", "provider_checkout_id");

