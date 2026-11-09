-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "for_transfers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "name_verified" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "bank_accounts_tenant_id_for_transfers_is_active_idx" ON "bank_accounts"("tenant_id", "for_transfers", "is_active");


-- At most one default transfer account per store.
CREATE UNIQUE INDEX "bank_accounts_one_default_transfer" ON "bank_accounts" ("tenant_id") WHERE "for_transfers" AND "is_default" AND "is_active";
-- Bank-transfer payments always carry the customer's (or staff's) report of the transfer. NOT VALID: enforced for
-- every new or changed row; older demo rows created before Phase 7 are left as they are.
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_transfer_evidence" CHECK ("provider" <> 'BANK_TRANSFER' OR "transfer_evidence" IS NOT NULL) NOT VALID;
