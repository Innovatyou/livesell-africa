-- Phase 5 money-integrity backstops.

-- Platform ledger accounts have tenant_id NULL, which a plain unique index does not de-duplicate.
CREATE UNIQUE INDEX "ledger_accounts_platform_code_currency" ON "ledger_accounts" ("code", "currency") WHERE "tenant_id" IS NULL;

-- One successful payment per order and per subscription invoice purpose cannot be double-recorded by reference.
-- (UNIQUE(reference), UNIQUE(idempotency_key) and UNIQUE(provider, provider_reference) already exist.)

-- Amount bookkeeping on a transaction must be coherent when known.
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_split_coherent" CHECK (
  ("provider_fee_minor" IS NULL OR "provider_fee_minor" >= 0)
  AND ("seller_proceeds_minor" IS NULL OR "seller_proceeds_minor" >= 0)
  AND ("seller_proceeds_minor" IS NULL OR "seller_proceeds_minor" + "platform_commission_minor" + COALESCE("provider_fee_minor", 0) = "gross_minor")
);

-- Refunds: positive (existing CHECK) and currency format.
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_currency_fmt" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Webhook events and refunds are evidence: no deletes.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% rows cannot be deleted', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER payment_webhook_events_no_delete BEFORE DELETE ON payment_webhook_events FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payment_transactions_no_delete BEFORE DELETE ON payment_transactions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payment_refunds_no_delete BEFORE DELETE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION forbid_delete();
