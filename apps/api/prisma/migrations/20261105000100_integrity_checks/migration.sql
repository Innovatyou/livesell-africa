-- Financial and inventory integrity enforced at the database, not just the app.

-- Inventory: never negative, never reserve more than on hand (prevents overselling even under bugs).
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_on_hand_nonneg" CHECK ("on_hand" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_nonneg" CHECK ("reserved" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_lte_on_hand" CHECK ("reserved" <= "on_hand");

-- Money columns are minor units and never negative.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_price_nonneg" CHECK ("price_minor" >= 0 AND ("promo_price_minor" IS NULL OR "promo_price_minor" >= 0) AND ("cost_price_minor" IS NULL OR "cost_price_minor" >= 0));
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_nonneg" CHECK ("subtotal_minor" >= 0 AND "discount_minor" >= 0 AND "delivery_fee_minor" >= 0 AND "total_minor" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_qty_pos" CHECK ("quantity" > 0 AND "unit_price_minor" >= 0 AND "line_total_minor" >= 0);
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_gross_pos" CHECK ("gross_minor" > 0 AND "platform_commission_minor" >= 0);
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_amount_pos" CHECK ("amount_minor" > 0);
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_amount_pos" CHECK ("amount_minor" > 0);
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_amount_nonneg" CHECK ("amount_minor" >= 0);

-- Currency codes are upper-case ISO-4217.
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_currency_fmt" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_fmt" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Store slugs: lowercase, url-safe, 3–40 chars.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_fmt" CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$');

-- Commission basis points within 0–100%.
ALTER TABLE "seller_payment_accounts" ADD CONSTRAINT "seller_payment_accounts_bps" CHECK ("commission_bps" IS NULL OR ("commission_bps" BETWEEN 0 AND 10000));
ALTER TABLE "affiliate_accounts" ADD CONSTRAINT "affiliate_accounts_bps" CHECK ("commission_bps" BETWEEN 0 AND 10000);

-- Ledger: every journal must balance. Deferred so all lines of a journal can be inserted in one transaction.
CREATE OR REPLACE FUNCTION ledger_journal_balanced() RETURNS trigger AS $$
DECLARE imbalance BIGINT;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE -amount_minor END), 0)
    INTO imbalance FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'Ledger journal % is unbalanced by % minor units', NEW.journal_id, imbalance;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();

-- Ledger and audit rows are append-only.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
