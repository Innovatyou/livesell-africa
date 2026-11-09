-- Pricing-model integrity: commission plans carry a rate and no fixed fee; subscription plans carry no rate.
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_pricing_model" CHECK (
  ("pricing_model" = 'COMMISSION'
     AND "commission_bps" BETWEEN 0 AND 10000
     AND "monthly_price_minor" = 0 AND "annual_price_minor" = 0)
  OR ("pricing_model" = 'SUBSCRIPTION' AND "commission_bps" IS NULL)
);

-- Sales enquiries: bounded free text (the API validates too).
ALTER TABLE "sales_inquiries" ADD CONSTRAINT "sales_inquiries_message_len" CHECK (char_length("message") BETWEEN 10 AND 3000);
