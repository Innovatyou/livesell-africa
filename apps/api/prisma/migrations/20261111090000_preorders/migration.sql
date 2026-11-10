-- Phase 14: pre-orders (selling beyond stock). Off by default.
ALTER TABLE "storefront_settings" ADD COLUMN "allow_preorders" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "order_items" ADD COLUMN "backordered_qty" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_backordered_qty_check" CHECK ("backordered_qty" >= 0 AND "backordered_qty" <= "quantity");
-- Restock allocation looks up waiting lines per variant (oldest order first, joined on orders.created_at).
CREATE INDEX "order_items_backordered_idx" ON "order_items" ("tenant_id", "variant_id") WHERE "backordered_qty" > 0;
