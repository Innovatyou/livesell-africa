-- Phase 2 integrity rules enforced at the database (the services enforce them too; these are the backstop).

-- SaaS billing amounts are minor units and never negative.
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_amount_nonneg" CHECK ("amount_minor" >= 0);
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_currency_fmt" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_period" CHECK ("period_end" > "period_start");
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_prices_nonneg" CHECK (
  ("monthly_price_minor" IS NULL OR "monthly_price_minor" >= 0) AND ("annual_price_minor" IS NULL OR "annual_price_minor" >= 0)
);
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_trial_days" CHECK ("trial_days" BETWEEN 0 AND 365);
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_currency_fmt" CHECK ("currency" ~ '^[A-Z]{3}$');

-- A tenant has at most one live subscription. Concurrent plan changes or a double registration bootstrap
-- cannot create a second one.
CREATE UNIQUE INDEX "subscriptions_one_live_per_tenant"
  ON "subscriptions" ("tenant_id") WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE');

-- Subscription history is append-only (corrections are new events, never edits).
CREATE TRIGGER subscription_events_append_only BEFORE UPDATE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Business verification: one open (PENDING) submission per tenant.
CREATE UNIQUE INDEX "business_verifications_one_pending_per_tenant"
  ON "business_verifications" ("tenant_id") WHERE "status" = 'PENDING';
