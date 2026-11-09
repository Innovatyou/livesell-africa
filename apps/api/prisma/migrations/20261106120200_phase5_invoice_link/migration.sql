
-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN     "subscription_invoice_id" UUID;

-- CreateIndex
CREATE INDEX "payment_transactions_subscription_invoice_id_idx" ON "payment_transactions"("subscription_invoice_id");

-- CreateIndex
CREATE INDEX "payment_transactions_status_created_at_idx" ON "payment_transactions"("status", "created_at");

