-- Phase 3 integrity backstops (the API validates the same rules).

-- Product codes are what customers type on WhatsApp / see in live sessions: upper-case, so the per-tenant
-- unique index is effectively case-insensitive. 2–20 characters, letters, digits and hyphens.
ALTER TABLE "products" ADD CONSTRAINT "products_code_fmt" CHECK ("product_code" ~ '^[A-Z0-9][A-Z0-9-]{1,19}$');
ALTER TABLE "products" ADD CONSTRAINT "products_slug_fmt" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 80);
ALTER TABLE "products" ADD CONSTRAINT "products_low_stock_nonneg" CHECK ("low_stock_threshold" >= 0);
ALTER TABLE "products" ADD CONSTRAINT "products_weight_nonneg" CHECK ("weight_grams" IS NULL OR "weight_grams" >= 0);
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sku_fmt" CHECK ("sku" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_promo_lte_price" CHECK ("promo_price_minor" IS NULL OR "promo_price_minor" <= "price_minor");
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_slug_fmt" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

-- Customers: reachable by phone or email, unless their personal data was erased on request.
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_present" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL OR "anonymized_at" IS NOT NULL);
ALTER TABLE "customers" ADD CONSTRAINT "customers_phone_e164" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{7,14}$');

-- Stock movement history is append-only: corrections are new movements, never edits.
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
