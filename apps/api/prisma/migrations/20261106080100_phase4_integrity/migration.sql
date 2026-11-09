-- Phase 4 integrity backstops (the order service computes the same values).

-- Order arithmetic must add up: total = subtotal − discount + delivery; line total = unit × qty − line discount.
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_consistent"
  CHECK ("total_minor" = "subtotal_minor" - "discount_minor" + "delivery_fee_minor");
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_line_consistent"
  CHECK ("line_total_minor" = "unit_price_minor" * "quantity" - "discount_minor" AND "discount_minor" >= 0);

-- Live session viewer numbers are only ever what the seller (or an official API) reports; never negative.
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_peak_viewers_nonneg" CHECK ("peak_viewers" IS NULL OR "peak_viewers" >= 0);
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_times" CHECK ("ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at");
ALTER TABLE "live_session_products" ADD CONSTRAINT "live_session_products_price_nonneg" CHECK ("session_price_minor" IS NULL OR "session_price_minor" >= 0);

-- Order activity history is append-only.
CREATE TRIGGER order_status_history_append_only BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
