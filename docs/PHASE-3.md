# Phase 3 report — products, inventory, storefronts, customer management

Scope: MASTER-SPEC §28 Phase 3, covering §8 (products and inventory), §9 (product codes), §10 (storefront) and §17
(CRM).

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **36 / 36** (29 earlier + 7 new) |
| API e2e (real Postgres + Redis + AWS S3 test bucket) | **83 / 83**: 21 Phase 1 + 37 Phase 2 + 25 Phase 3 |
| Web tests (Vitest) | **14 / 14** |
| `tsc --noEmit`, `nest build`, `next build` | clean; web has 29 routes |
| Drift check after the new migrations | empty |
| Live smoke test (`node dist/main.js` + `next start`) | seller APIs, publish, and server-rendered store / product / cart pages OK; unknown store → 404 |

## What was built

### Products and variants (§8, §9)
- **Products.** Name, description, category, status (draft / active / archived), tags, photos and videos, weight,
  dimensions and a low-stock alert level.
- **Variants.** Every sellable unit is a variant with up to 4 attributes (Colour, Size, Model, Material or custom),
  plus a SKU, regular, promotional and cost price, and its own stock row. A simple product has one variant with no
  attributes.
  - Variant rules are checked: every variant uses the same attribute names, no duplicate combinations, and the
    promotional price can't exceed the regular price (also enforced by a database check).
- **Product codes (§9).** Codes like `BAG001` are generated from the category or the product name. Numbers never
  repeat across the store (`BAG001`, `SNEAK002`, `DRESS003` …), so a code announced in an old live never points to a
  different product.
  - Codes are stored upper-case, unique per store, and stay reserved after deletion.
  - There's a "Suggest" button and a lookup by code.
- **Changing variants.** Variants left out of an edit are deactivated, not deleted, so order history keeps them.
  Each product's URL slug is fixed at creation, so shared links keep working after a rename.
- **List and search.** Search covers name, code and SKU. Filters: status, category, stock (in / low / out); sort by
  newest, name or price; pagination.
- **Bulk updates.** Status, category, add/remove tags, and price changes by percentage (BigInt kobo, rounded half
  up; a promo price that would end up above the new price is cleared). Activating a product with no sellable variant
  is refused.
- **CSV import/export.**
  - Export is one row per variant, with spreadsheet-formula injection blocked.
  - Import checks every row first and reports problems by spreadsheet row number. It is all-or-nothing in one
    transaction, with a dry run, and categories are created automatically.
  - Products match on their product code and variants on SKU or attributes, so re-importing an export updates
    rather than duplicates; the stock column is applied as a stock count.
  - Limit: 1,000 rows per import (JSON body limit raised to 3 MB).
- **Media.**
  - Photos: PNG/JPG/WebP up to 5 MB. Videos: MP4/WebM up to 50 MB.
  - Uploads use the existing presigned-URL flow: only this store can confirm a file, only once, and its real type is
    checked from the file's first bytes.
  - Up to 10 files per product, with ordering and alt text. Removed files are deleted from storage.
- **Plan limits.** The product limit is enforced on create and on import.
- **Roles.** `products:*` and `inventory:*` permissions apply; a sales assistant can view but not edit.

### Inventory (§8)
- **One stock implementation** (`InventoryService`), shared with orders in Phase 4. Every change:
  - locks the stock row with `SELECT … FOR UPDATE`, taking rows in a fixed order to avoid deadlocks;
  - writes a movement record with the on-hand and reserved balances after the change;
  - bumps the row's version. The movement history can't be edited or deleted (database trigger).
- **Seller adjustments.** Add, remove, or set to a counted quantity, with a reason. They're audited, and **stock can
  never go below units reserved for open orders.**
- **For Phase 4** (run inside the order transaction):
  - `reserve()`: all-or-nothing, and it reports what *is* available when it can't reserve.
  - `release()`: never releases more than is reserved.
  - `commitSale()`.
- **Low-stock list.** Variants at or below their product's alert level, shown on the inventory page with a restock
  action.

### Storefront (§10)
- **Seller side.**
  - A publish/unpublish switch. Publishing needs a store description, a WhatsApp or contact number, and at least one
    active product; the missing items are listed.
  - A cover image (≤ 3 MB), an accent colour from 8 options that each keep white text readable, and order
    instructions (§9, e.g. "Send the product code to our WhatsApp").
  - A copyable public link.
- **Public API (`/api/v1/store/:slug`).** Store profile, catalogue (search incl. code and tags, category, price sort,
  pagination), product page and **lookup by code**.
- **What the public API never shows:** cost prices, exact stock (only in stock / low / out, plus "only N left" when
  low), drafts, archived products or inactive variants.
- **When a store is hidden.** It's visible only while published, not suspended or closed, and on a live
  subscription. Unknown, hidden and lapsed stores all return the same 404.
- **Web pages (`/store/[slug]`).** Server-rendered with metadata and Open Graph tags, refreshed every 60 seconds,
  mobile-first:
  - store page: cover, description, how-to-order, a **"Saw a code in a live? Enter it here"** box, search, category
    chips, sort, product grid;
  - product page: gallery and video, variant picker, availability, quantity, add to cart, ask on WhatsApp, share;
  - floating WhatsApp button and social links.
- **Cart and ordering.** The cart is saved in the browser per store. Checkout is **"Send order on WhatsApp"**: a
  message with product codes, variants, quantities and the total, sent to the seller's number (or a call link if
  there's no WhatsApp number). The page says plainly that the seller confirms availability and payment, and that
  online checkout is coming. Nothing is reserved yet; Phase 4 orders will do that.

### Customer management (§17)
- **Customer records.** Profiles with contact details, tags, internal notes, WhatsApp opt-in (with the opt-in time)
  and multiple addresses, one of them the default.
  - At least a phone or an email is required. Phone numbers are unique per store; a duplicate returns the existing
    customer's id so the UI can link to it.
- **Stats** are computed from orders every time: order count, paid orders, **total spent** (paid orders in the store
  currency), open orders, first and last order.
- **Segments.**
  - Repeat: 2+ paid orders.
  - New: added in the last 30 days.
  - Top spenders: top 10% by paid spend.
  - Inactive: has bought, nothing in 90 days.
  - Open orders.
  - WhatsApp opt-in.
  - Sorting by spend, orders, last order, name or newest finds the most valuable customers.
- **Export.** CSV, requiring the `customers:export` permission (owner only by default). It is **audited** with a
  count, excludes erased customers, and blocks formula injection.
- **Erasure (NDPA).** "Erase personal data" removes name, contact details, notes, tags, addresses *and* the delivery
  addresses copied onto finished orders, while keeping order amounts for accounting. It's refused while orders are
  open.
- **Delete** is only allowed for customers who never ordered. Every change is audited.

### Setup checklist and app
- The checklist gains **Add your first product** and **Publish your storefront**. Phase 2 said the checklist would
  grow; its one Phase 2 test was updated to the new list, and that test's other checks are unchanged.
- New pages: Products (list, filters, bulk bar, import dialog with preview, export), Product editor (option builder →
  variant matrix, media manager, stock adjust dialog, stock history), Categories, Inventory (low stock + history),
  Customers (segment tabs, search, sort, new customer, export), Customer detail (profile, stats, addresses, orders,
  erase/delete), and Storefront settings.
- Every data view has loading, empty, error and success states.

## Schema changes
- `20261105151435_phase3_catalogue_crm` (generated): `inventory_movements.on_hand_after/reserved_after`,
  `customers.anonymized_at`, `storefront_settings.order_instructions`.
- `20261105151500_phase3_integrity` (hand-written backstops):
  - format checks on product code, slug, SKU and category slug;
  - non-negative low-stock level and weight; promo ≤ price;
  - a category can't be its own parent;
  - customers must have a phone or email unless erased, and phones must be in E.164 format;
  - stock movements can't be edited or deleted (trigger).
- No new tenant-owned tables, so the tenant-isolation model list is unchanged (its test passes).

## Tests added
- **Unit:** slugs, code prefixes and numbering, SKUs and variant names, naira→kobo parsing, attributes, CSV parsing
  (quotes, newlines, CRLF, BOM), formula neutralisation, MP4/WebM detection.
- **E2E (`test/phase3.e2e-spec.ts`, 25 tests):**
  - Products: code generation and numbering; variant matrix and every validation; updates (slug kept, deactivation,
    SKU protection, foreign variant ids refused); categories (cycles, delete rules); list, search, filters and
    pagination; bulk updates incl. kobo rounding; soft delete keeps the code reserved; plan limit on create and
    import; role permissions.
  - Media on real S3: tenant-bound, single use, disguised file rejected, removed file deleted.
  - **§26 #6:** adjustments with audited history; never below reserved.
  - **§26 #7:** two simultaneous reservations for the last unit → exactly one succeeds; 10 concurrent buyers for 3
    units → exactly 3. Reservations are all-or-nothing, and release and sale keep balances consistent.
  - **§26 #9:** cross-tenant access to products, variants, stock, customers and addresses → 404 or 403.
  - CSV: dry run, real import, round trip without duplicates, errors with row numbers, SKU owner clash, formula
    neutralisation.
  - Storefront: publish rules; public responses checked for leaks of cost, stock, internal ids and drafts; lookup by
    code; search, category, sort; hidden when unpublished, suspended or lapsed, all with the same 404; cover image;
    reserved slugs.
  - CRM: contact rules, duplicates, opt-in time; every segment and sort from real orders; export permission, audit
    and exclusions; erasure incl. order address snapshots; addresses with one default.
- **Web:** naira input ⇄ kobo; WhatsApp order message and cart total.

## Files
**New (API):** `src/catalog/{catalog.module,catalog.controller,catalog-utils,catalog-utils.spec,categories.service,products.dto,products.service,product-import.service}.ts`,
`src/inventory/{inventory.module,inventory.controller,inventory.service}.ts`,
`src/customers/{customers.module,customers.controller,customers.dto,customers.service}.ts`,
`src/storefront/{storefront.module,storefront.controller,storefront-admin.service,storefront-public.service}.ts`,
the two migrations above, and `test/phase3.e2e-spec.ts`.

**Changed (API):**
- `src/app.module.ts`: new modules, with the storefront registered after onboarding so `/store/profile` stays the
  seller route.
- `src/configure-app.ts`: 3 MB JSON body limit.
- `src/storage/upload-policy{,.spec}.ts`: covers, product images and videos.
- `src/onboarding/onboarding.service.ts`: two new checklist steps.
- `src/auth/auth.service.ts`: more reserved store usernames (`profile`, `logo`, …).
- `prisma/schema.prisma`, and `test/phase2.e2e-spec.ts` (checklist keys only).

**New (web):** `src/app/(app)/{products,products/new,products/[id],products/categories,inventory,customers,customers/[id],settings/storefront}/page.tsx`,
`src/app/store/[slug]/{layout,page,not-found,cart/page,p/[productSlug]/page}.tsx`,
`src/components/{dialog,product-form}.tsx`,
`src/components/store/{cart,cart-view,code-lookup,product-buy-box}.tsx`,
`src/lib/{download,storefront,storefront.test}.ts`.

**Changed (web):** `src/lib/{types,money,money.test}.ts`, `src/components/app-shell.tsx` (navigation),
`src/app/(app)/onboarding/page.tsx`, `src/app/(marketing)/page.tsx` (feature labels).

**Other:** `infra/minio/public-logos-policy.json` (also covers and product media), `docker-compose.yml` (comment).

## Blocked or incomplete
1. **Online checkout and order tracking (§10)** need orders (Phase 4) and payments (Phase 5). Until then the cart
   sends a WhatsApp order message and reserves no stock; the page says so.
2. **Storage for public product media in production.** In development, storefront images and videos are served via
   1-hour presigned links. Pages refresh every 60 s, so links stay valid. Production should set `S3_PUBLIC_BASE_URL`
   to a CDN that exposes only `tenants/*/{logos,covers,products}/*`; on R2, use a separate public bucket. This is
   unchanged from Phase 2.
3. **Low-stock alerts** are shown in the app (inventory page). Email/WhatsApp alerts come with notifications in
   Phases 8–9.
4. **Local MinIO is still unverified.** Storage tests ran against your AWS test bucket. The docker-compose MinIO
   setup (bucket policy now covering logos, covers and product media) hasn't been run anywhere yet.
5. **Still open from Phase 2:** the commission option's rate and limits (placeholders), legal review, company
   details for the legal pages, and the trial/grace-period vs. Phase 5 timing.
6. **Minor:**
   - Product videos are checked by type and size only (no transcoding or thumbnails).
   - "Top spenders" is relative (top 10%), so it needs a few paying customers before it's meaningful.

## Needed from you
- Go-ahead for Phase 4 (order management and live-selling sessions).
- Still pending from earlier phases: the decisions in item 5, plus the Veltrix, Bachs, Paystack and Flutterwave
  sandbox credentials.
