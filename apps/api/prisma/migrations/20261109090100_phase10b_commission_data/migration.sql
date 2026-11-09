-- Separate from the migration that adds InvoiceKind.COMMISSION: Postgres can't use a new enum value in the same transaction.

-- One commission invoice per store per billing month (voided ones don't count).
CREATE UNIQUE INDEX "subscription_invoices_one_commission_per_period"
  ON "subscription_invoices" ("tenant_id", "period_start") WHERE "kind" = 'COMMISSION' AND "status" <> 'VOID';

-- "Pay as you sell" becomes the full product with no monthly fee: LiveSell earns commission on every verified sale.
UPDATE "subscription_plans"
   SET "description" = 'Everything in LiveSell, no monthly fee. A commission on each verified sale.',
       "limits" = '{"products": null, "ordersPerMonth": null, "staff": null, "paymentGateways": null}'::jsonb,
       "features" = '{"storefront": "full", "orderManagement": "advanced", "whatsappNotifications": true, "analytics": "advanced", "inventory": "advanced", "customerSegmentation": true, "automation": true}'::jsonb
 WHERE "code" = 'PAY_AS_YOU_SELL';

-- Couriers: a name is required.
ALTER TABLE "couriers" ADD CONSTRAINT "couriers_name_check" CHECK (length(btrim("name")) >= 2);
