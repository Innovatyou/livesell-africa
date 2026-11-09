-- AlterTable
ALTER TABLE "payment_transactions" ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "seller_payment_account_id" UUID;

-- AlterTable
ALTER TABLE "seller_payment_accounts" ADD COLUMN     "bank_account_id" UUID,
ADD COLUMN     "last_verified_at" TIMESTAMP(3),
ADD COLUMN     "test_mode" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_seller_payment_account_id_fkey" FOREIGN KEY ("seller_payment_account_id") REFERENCES "seller_payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

