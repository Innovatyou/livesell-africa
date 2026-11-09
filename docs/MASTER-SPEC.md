# MASTER SPEC — LIVESELL AFRICA
### The Operating System for Social Commerce & Live Selling

> **Decisions recorded after Phase 1** (these override the original text where they conflict):
> - **3D:** the product UI follows §24 (clean, Stripe/Linear-style). 3D is limited to the landing-page hero and optional product previews, lazy-loaded (react-three-fiber) so it never slows mobile users.
> - **Prisma 7** with the `@prisma/adapter-pg` driver adapter (replaces "Prisma ORM" generically).
> - **Object storage:** MinIO for local development and tests (in docker-compose); Cloudflare R2 or AWS S3 in staging/production. The code talks only the S3 API, configured via `S3_*` env vars.
> - **Tenant selection:** authenticated requests carry `X-Tenant-Id`; the server validates membership (see ARCHITECTURE.md).
> - **Mobile app (decided after Phase 8):** LiveSell needs a seller mobile app built with **React Native** (TypeScript), using the same `/api/v1` API (`X-Client-Type: mobile` sessions). Scheduled as its own phase after Phase 10, unless reprioritised.

## 1. PROJECT OVERVIEW

Act as a principal software architect, senior Node.js engineer, SaaS product designer, payment integration specialist and UI/UX developer.

Your task is to design and build an advance 3D interactive app name **LiveSell Africa**, a production-ready, multi-tenant SaaS platform that helps individuals, retailers, brands, influencers and businesses sell products through TikTok Live, Instagram Live, Facebook Live, WhatsApp and other social commerce channels.

LiveSell Africa should provide sellers with all the tools they need to convert social media viewers into paying customers, manage orders, process payments, track inventory, communicate with customers and fulfil deliveries.

The platform should be designed primarily for Nigeria, with an architecture that supports expansion into other African countries and international markets.

### Product positioning

"Turn Every Live Session Into a Sales Opportunity."

LiveSell is not simply an online store. It is a complete social commerce management platform.

The platform must be easy enough for a small Instagram or TikTok vendor to use while providing the functionality required by established retailers and large brands.

## 2. CORE BUSINESS OBJECTIVES

Build a platform that enables sellers to:

1. Create an online seller account.
2. Create a branded online storefront.
3. Upload and manage products.
4. Manage inventory, product variations and pricing.
5. Create and manage live-selling sessions.
6. Receive orders from customers watching live streams.
7. Share product links and product codes during live sessions.
8. Accept payments through multiple payment providers.
9. Receive customer payments directly into their own payment gateway accounts or bank accounts.
10. Receive automated WhatsApp, SMS and email notifications.
11. Manage customer records.
12. Track orders, payments, delivery and returns.
13. Analyse sales performance.
14. Manage multiple sales channels from one dashboard.

The SaaS platform owner must be able to manage tenants, subscriptions, platform revenue, payment integrations, system settings and service consumption.

## 3. TECHNOLOGY STACK

Use the following technology stack.

### Backend
- Node.js 22+
- TypeScript
- NestJS
- REST API architecture
- WebSockets / Socket.IO
- Swagger / OpenAPI documentation
- Background jobs using BullMQ

### Frontend
- Next.js
- React
- TypeScript
- Tailwind CSS
- Responsive design
- Component-based architecture

### Database and infrastructure
- PostgreSQL
- Prisma ORM
- Redis
- S3-compatible object storage
- Docker
- Nginx
- Environment-based configuration

### Security
- JWT authentication
- Refresh token rotation
- Role-based access control
- Tenant-level data isolation
- API rate limiting
- Input validation
- Audit logging
- Webhook signature verification
- Secure secrets management

Use clean architecture, dependency injection, reusable services and modular code.

Do not put the entire application in one controller or service.

## 4. MULTI-TENANT SAAS ARCHITECTURE

LiveSell must support multiple independent sellers using one SaaS platform.

Each seller must have a dedicated tenant workspace.

Example:

- livesell.africa/store/fashionbyada
- livesell.africa/store/officialbeauty
- livesell.africa/store/techworld

Allow custom domains and subdomains in future releases.

Every seller must have isolated:

- Products
- Customers
- Orders
- Transactions
- Inventory
- Storefront settings
- Payment gateway configurations
- Notifications
- Reports
- Staff accounts

Enforce tenant isolation at the backend and database-query levels.

Never trust a tenant ID supplied by the frontend without validating the authenticated user's membership and permissions.

## 5. USER ROLES

Implement the following roles.

### Platform administrator
- Manage the entire SaaS platform.
- Create and manage subscription plans.
- View all registered sellers.
- Suspend or activate accounts.
- Manage platform payment integrations.
- Monitor system activity.
- View aggregate platform analytics.
- Manage API integrations.
- Manage customer support.
- View platform revenue and subscription payments.

### Seller / Business owner
- Manage their store.
- Manage staff.
- Add products.
- Manage payment methods.
- Manage customers and orders.
- Manage inventory.
- View reports.
- Configure notifications.
- Manage subscriptions.

### Store manager
- Manage daily store operations.
- Manage products and orders.
- View inventory.
- Manage customer records.

### Sales assistant
- Create customer orders.
- Register orders during live sessions.
- Check product availability.
- Update order statuses according to permissions.

### Live moderator
- Manage live-selling activities.
- Record customer requests.
- Register orders.
- Monitor product availability.
- Manage session sales activity.

### Customer
- Browse products.
- Place orders.
- Make payments.
- Track orders.
- View purchase history.
- Contact sellers.

## 6. SELLER REGISTRATION AND ONBOARDING

Create a comprehensive seller registration process.

Collect:

- Business name.
- Owner's full name.
- Email.
- Phone number.
- Country.
- State.
- City.
- Business address.
- Business category.
- Store username.
- Password.

Support individual sellers and registered businesses.

Allow sellers to upload their business logo and configure their storefront.

Include:

- Email verification.
- Phone verification.
- Password recovery.
- Optional business verification.
- Terms and conditions acceptance.
- Privacy policy acceptance.

Provide a guided onboarding checklist after registration.

## 7. SELLER DASHBOARD

Create a modern dashboard showing:

- Total sales today.
- Total sales this month.
- Total orders.
- Paid orders.
- Pending payments.
- Cancelled orders.
- Products sold.
- Available inventory.
- Outstanding orders.
- Average order value.
- Top-selling products.
- Recent customers.
- Recent transactions.

Include sales charts with daily, weekly, monthly and yearly filters.

Use real database data. Do not use hardcoded dashboard figures.

## 8. PRODUCT AND INVENTORY MANAGEMENT

Develop a complete product management module.

Product fields:

- Product name.
- Product description.
- Product SKU.
- Product category.
- Product images.
- Product videos.
- Regular price.
- Promotional price.
- Cost price.
- Available quantity.
- Product status.
- Product variations.
- Product tags.
- Weight and dimensions.

Support variations such as:

- Size.
- Colour.
- Model.
- Material.
- Other custom attributes.

Include:

- Stock adjustments.
- Low-stock alerts.
- Stock reservation.
- Stock release.
- Inventory movement history.
- Product import and export.
- Bulk product updates.
- Product availability tracking.

Prevent overselling through database transactions and appropriate stock locking.

## 9. LIVE SELLING MANAGEMENT

Create a dedicated Live Selling module.

Allow sellers to:

- Create a live session.
- Enter session title.
- Select sales channel.
- Set scheduled date and time.
- Select products to promote.
- Set session descriptions.
- Assign moderators.
- Record session performance.
- End sessions and generate sales reports.

Supported channels:

- TikTok Live.
- Instagram Live.
- Facebook Live.
- YouTube Live.
- WhatsApp Live Commerce.
- Other manually configured channels.

Do not assume TikTok permits unrestricted access to live comments, viewer information or live-stream data.

Use officially supported APIs and permissions.

Provide manual order entry and product-code ordering as fallback mechanisms.

### Product code ordering

Every product should have a unique product code.

Example:

BAG001 = Premium Leather Bag
SHOE002 = Men's Sneakers
DRESS003 = Women's Evening Dress

During a TikTok Live, a seller can announce:

"Send BAG001 to our WhatsApp to order."

The customer can use a product code to retrieve product details and begin checkout.

Provide a product code generator and configurable order instructions.

## 10. CUSTOMER STOREFRONT

Every seller should receive a responsive online storefront.

Example:

livesell.africa/store/fashionbyada

Features:

- Store logo.
- Cover image.
- Business description.
- Contact details.
- Social media links.
- Product catalogue.
- Product categories.
- Search.
- Product variations.
- Shopping cart.
- Checkout.
- Payment options.
- Order tracking.
- WhatsApp contact button.

Storefronts should be optimised for mobile devices because most social commerce customers will arrive through mobile phones.

Provide shareable product links.

## 11. ORDER MANAGEMENT

Build a complete order management system.

Order information should include:

- Order reference.
- Seller/tenant ID.
- Customer information.
- Products.
- Product quantities.
- Unit prices.
- Discounts.
- Delivery charges.
- Total amount.
- Payment method.
- Payment status.
- Fulfilment status.
- Sales channel.
- Live session reference.
- Order date.

Support these statuses:

- Draft.
- Pending payment.
- Payment verification.
- Paid.
- Processing.
- Ready for dispatch.
- Dispatched.
- Delivered.
- Cancelled.
- Refunded.
- Partially refunded.

Include order search, filters, export, invoices and printable receipts.

Maintain a complete order activity history.

## 12. PAYMENT GATEWAY INTEGRATION

This is a critical part of the application.

Implement a provider-independent payment architecture.

Create a unified payment interface so Paystack, Flutterwave and Bachs can be managed through the same application service.

Payment providers:

1. Paystack.
2. Flutterwave.
3. Bachs.

Official documentation:

Paystack:
https://paystack.com/docs/

Flutterwave:
https://developer.flutterwave.com/

Bachs:
https://docs.bachs.io/developer-portal/api-keys

### Payment gateway requirements

Each seller should be able to configure their own payment gateway credentials.

Allow:

- Platform-managed gateway configuration where supported.
- Seller-owned gateway credentials.
- Provider-supported connected accounts and subaccounts.
- Direct merchant settlement.
- Split settlement where approved.
- Payment status verification.
- Webhook processing.
- Refunds where supported.
- Transaction history.
- Payment reconciliation.

Never expose secret API keys to the browser.

Encrypt credentials at rest and restrict access to authorised backend services.

Use environment variables for platform-level secrets.

### Paystack integration

Implement:

- Transaction initialization.
- Transaction verification.
- Webhook handling.
- Payment status updates.
- Subaccount integration.
- Split payments where supported.
- Refund operations where supported.

Documentation:
https://paystack.com/docs/

### Flutterwave integration

Implement:

- Payment link or checkout creation.
- Transaction verification.
- Webhook handling.
- Subaccount support.
- Split payments where supported.
- Refund operations where supported.

Documentation:
https://developer.flutterwave.com/

### Bachs integration

Use the official Node.js SDK where applicable.

SDK:
@bachs/sdk

Documentation:
https://docs.bachs.io/developer-portal/api-keys

Implement:

- API key configuration.
- Sandbox and live environments.
- Checkout session creation.
- Payment verification.
- Webhook signature verification.
- Connected accounts through Bachs Connect.
- Direct charges.
- Destination charges where supported.
- Subaccount management.
- Payouts where authorised.
- Refunds where supported.
- Virtual account operations where authorised.

For API operations not supported by the SDK, implement secure REST clients based on the official API documentation.

Do not invent undocumented API endpoints or parameters.

### Payment gateway abstraction

Define a common interface such as:

PaymentProvider:
- initializePayment()
- verifyPayment()
- processWebhook()
- refundPayment()
- createSubaccount()
- getTransaction()
- getSupportedPaymentMethods()

Implement separate provider adapters.

All provider-specific logic must remain inside its respective adapter.

### Payment settlement architecture

Support three seller payment arrangements:

A. Direct settlement:
Customer pays through the seller's connected merchant account. The seller receives settlement according to the provider's settlement terms.

B. Split settlement:
Where approved and supported, the seller receives their share and LiveSell receives its platform commission.

C. Bank transfer:
Customer transfers directly to the seller's bank account or an assigned provider-supported virtual account.

Never assume that all providers offer identical subaccount, settlement, virtual-account or split-payment functionality.

Verify current capabilities, fees, eligibility and compliance requirements against official documentation.

### Payment reconciliation

Implement a central transaction ledger.

Record:

- Transaction reference.
- Order reference.
- Seller ID.
- Customer ID.
- Payment provider.
- Gross amount.
- Currency.
- Provider fees, where available.
- Platform commission.
- Seller proceeds.
- Payment status.
- Settlement status.
- Provider reference.
- Webhook events.
- Transaction timestamps.

Use idempotency keys and unique transaction constraints to prevent duplicate payments and order updates.

Never mark an order as paid based only on a browser redirect or customer-uploaded payment screenshot.

For bank transfers, allow manual verification by authorised sellers or use provider-supported transaction notifications.

Separate seller sales transactions from LiveSell subscription revenue.

## 13. DIRECT BANK TRANSFER

Allow each seller to configure:

- Bank name.
- Account name.
- Account number.
- Transfer instructions.
- Optional virtual account.
- Supported currencies.

During checkout, display the seller's payment details.

Allow customers to submit payment references and transfer evidence.

Provide seller-side payment verification.

Use payment reconciliation where a provider supplies reliable transaction notifications.

Clearly identify unverified transfers.

## 14. SAAS SUBSCRIPTION AND BILLING

LiveSell must have its own subscription billing system.

Do not confuse SaaS subscription payments with customer product payments.

Create subscription plans:

Starter:
- Product catalogue.
- Basic storefront.
- Limited orders.
- Basic order management.

Professional:
- More products.
- Advanced order management.
- WhatsApp notifications.
- Sales analytics.
- Inventory management.
- Multiple staff accounts.

Business:
- Advanced analytics.
- Multiple staff and permissions.
- Advanced inventory.
- Multiple payment gateways.
- Customer segmentation.
- Advanced automation.

Enterprise:
- Custom pricing.
- Higher limits.
- Dedicated support.
- Advanced reporting.
- Custom integrations.

Suggested initial pricing:

Starter: ₦5,000/month.
Professional: ₦12,000/month.
Business: ₦25,000/month.
Enterprise: Custom pricing.

These are initial pricing proposals and should be configurable from the administrator dashboard.

Implement:

- Monthly subscriptions.
- Annual subscriptions.
- Free trials.
- Plan upgrades.
- Plan downgrades.
- Renewal reminders.
- Subscription expiry.
- Payment retries.
- Subscription invoices.
- Subscription history.

Support Paystack, Flutterwave and Bachs as platform billing providers where appropriate.

## 15. VELTRIX API INTEGRATION

Integrate Veltrix as the primary external messaging and verification service provider.

Veltrix API should be treated as a separate integration layer.

Use the official Veltrix API documentation and credentials supplied by the platform administrator.

Do not invent endpoints, authentication formats or request payloads.

Create a configurable Veltrix integration service.

Use secure server-side API authentication.

### Required integration capabilities

WhatsApp:
- Order confirmation.
- Payment confirmation.
- Payment reminders.
- Dispatch notifications.
- Delivery notifications.
- Abandoned checkout reminders.
- Customer support notifications.

SMS:
- OTP.
- Order alerts.
- Payment alerts.
- Delivery alerts.

Email:
- Receipts.
- Invoices.
- Order notifications.
- Subscription reminders.
- Account verification.

Verification:
- Seller verification.
- Customer verification where appropriate.
- Address verification where required.
- Business verification where supported.

AI:
- Automated customer support where the Veltrix API provides the necessary service.
- Automated order-status responses where supported.

### Messaging billing

Implement messaging usage tracking.

Record:

- Seller ID.
- Notification type.
- Destination.
- Message reference.
- Service provider.
- Cost.
- Delivery status.
- Timestamp.

Allow platform administrators to configure messaging pricing and seller usage limits.

Support a platform-level Veltrix account with properly attributed seller consumption.

Do not assume Veltrix supports per-tenant API credentials or subaccounts until verified.

Provide a dedicated integration settings page.

## 16. WHATSAPP ORDERING AUTOMATION

Create a WhatsApp commerce workflow using Veltrix WhatsApp API.

Example:

Customer sends:
BAG001

System responds:

"Welcome! You selected Premium Leather Bag.

Price: ₦25,000.

Available colours:
- Black
- Brown
- Wine

Reply with your preferred colour to continue."

After selection:

Collect:
- Full name.
- Phone number.
- Delivery address.
- Quantity.

Generate an order and checkout link.

Send payment instructions.

After payment verification, send order confirmation.

Use WhatsApp templates where required by Meta's policies.

Support opt-in and opt-out management.

## 17. CUSTOMER MANAGEMENT / CRM

Build a lightweight CRM.

Features:

- Customer profiles.
- Contact details.
- Purchase history.
- Total spending.
- Number of orders.
- Outstanding orders.
- Customer notes.
- Customer tags.
- Repeat customer identification.
- Customer segmentation.

Allow sellers to identify their most valuable customers.

Support customer export with appropriate access controls.

## 18. LOGISTICS AND DELIVERY

Build a delivery management module.

Support:

- Pickup.
- Seller-managed delivery.
- Third-party delivery.
- Delivery fee configuration.
- Delivery zones.
- Delivery status.
- Tracking references.
- Dispatch notes.

Allow integration with logistics providers through configurable adapters.

Do not hardcode logistics providers.

Allow sellers to update delivery statuses manually where integrations are unavailable.

## 19. LIVE SELLING ANALYTICS

Create a dedicated analytics module.

Track:

- Number of live sessions.
- Orders generated per session.
- Revenue per session.
- Number of products sold.
- Average order value.
- Conversion rate where reliable viewer data exists.
- Top-performing products.
- Customer acquisition.
- Repeat purchases.
- Payment completion rate.
- Cancellation rate.

Provide comparisons across sessions and sales channels.

Allow CSV and PDF reports.

Do not fabricate viewer statistics when TikTok does not provide the required data.

## 20. AFFILIATE AND CREATOR MANAGEMENT

Create a future-ready affiliate module.

Features:

- Creator registration.
- Seller invitations.
- Campaign management.
- Unique referral links.
- Discount codes.
- Sales attribution.
- Commission configuration.
- Commission reports.
- Payout tracking.

Support manual attribution as a fallback.

Do not assume that TikTok's native affiliate APIs are available in Nigeria.

## 21. ADMINISTRATOR DASHBOARD

Build a comprehensive super-admin portal.

Include:

- Total registered sellers.
- Active sellers.
- Inactive sellers.
- Total orders.
- Total transaction volume.
- Total SaaS subscription revenue.
- Platform commissions.
- Payment gateway performance.
- Messaging usage.
- Subscription statistics.
- New registrations.
- Top-performing sellers.
- System health.
- Failed webhook events.
- Integration errors.

Allow the administrator to:

- Create subscription plans.
- Manage sellers.
- Suspend accounts.
- Manage payment providers.
- Configure Veltrix integration.
- Configure gateway credentials.
- Set commission rates.
- Manage platform notifications.
- View audit logs.
- Configure platform settings.

## 22. DATABASE DESIGN

Create a properly normalised PostgreSQL database.

Include tables for:

- users
- tenants
- tenant_members
- roles
- permissions
- subscriptions
- subscription_plans
- subscription_invoices
- products
- product_categories
- product_variants
- inventory
- inventory_movements
- customers
- customer_addresses
- orders
- order_items
- order_status_history
- live_sessions
- live_session_products
- sales_channels
- payment_providers
- seller_payment_accounts
- payment_transactions
- payment_webhook_events
- payment_refunds
- settlements
- ledger_accounts
- ledger_entries
- bank_accounts
- virtual_accounts
- notifications
- notification_usage
- storefront_settings
- delivery_orders
- delivery_zones
- staff_invitations
- audit_logs
- platform_settings
- affiliate_accounts
- affiliate_commissions

Use UUID primary keys.

Add proper indexes, foreign keys, unique constraints and tenant-aware query patterns.

Use database migrations.

Financial amounts must use decimal or integer minor-unit representations, never floating-point arithmetic.

Support multiple currencies, with NGN as the initial default.

## 23. SECURITY AND FINANCIAL INTEGRITY

This is a financial-commerce application. Security must be a core requirement.

Implement:

- Secure authentication.
- Strong password hashing.
- MFA-ready architecture.
- Role-based permissions.
- Tenant isolation.
- Encrypted gateway credentials.
- Webhook signature verification.
- API rate limiting.
- Request validation.
- CSRF protection where applicable.
- XSS protection.
- SQL injection protection.
- Audit logging.
- Secure file uploads.
- Idempotent payment processing.
- Duplicate webhook prevention.
- Database transaction handling.
- Financial ledger reconciliation.

Never store card PAN or CVV.

Never expose private keys in frontend code.

Do not permit sellers to access another tenant's financial records.

## 24. UI/UX DESIGN REQUIREMENTS

The interface should look like a modern, premium African fintech/SaaS product.

Design inspiration:

- Stripe Dashboard.
- Shopify Admin.
- Linear.
- Paystack Dashboard.
- Modern commerce analytics platforms.

Visual direction:

- Clean white or light background.
- Deep charcoal text.
- Professional green accent.
- Subtle borders.
- Rounded cards.
- Consistent spacing.
- Clear typography.
- Minimal visual clutter.
- Responsive layouts.

Use a consistent design system.

The seller dashboard must be mobile-friendly.

The administrator portal should have a professional desktop-oriented layout.

Create:

- Landing page.
- Pricing page.
- Registration page.
- Login page.
- Seller onboarding.
- Seller dashboard.
- Product management.
- Order management.
- Payment settings.
- Live session management.
- Storefront editor.
- Customer CRM.
- Analytics.
- Notification settings.
- Subscription management.
- Admin portal.

Use realistic empty states, loading states, validation errors and success messages.

Do not create non-functional buttons.

## 25. API ARCHITECTURE

Build versioned REST APIs.

Example endpoints:

Authentication:
- POST /api/v1/auth/register
- POST /api/v1/auth/login
- POST /api/v1/auth/refresh
- POST /api/v1/auth/logout

Products:
- GET /api/v1/products
- POST /api/v1/products
- PATCH /api/v1/products/:id
- DELETE /api/v1/products/:id

Orders:
- GET /api/v1/orders
- POST /api/v1/orders
- GET /api/v1/orders/:id
- PATCH /api/v1/orders/:id/status

Payments:
- POST /api/v1/payments/initialize
- GET /api/v1/payments/:reference/verify
- POST /api/v1/payments/:provider/webhook

Storefront:
- GET /api/v1/store/:slug
- GET /api/v1/store/:slug/products
- POST /api/v1/store/:slug/checkout

Live sessions:
- GET /api/v1/live-sessions
- POST /api/v1/live-sessions
- PATCH /api/v1/live-sessions/:id
- POST /api/v1/live-sessions/:id/end

Notifications:
- POST /api/v1/notifications/send
- GET /api/v1/notifications/history

Document all APIs with Swagger.

These are suggested API routes; implement them consistently with the actual domain model.

## 26. TESTING AND QUALITY ASSURANCE

Implement:

- Unit tests.
- Integration tests.
- API tests.
- Payment provider sandbox tests.
- Webhook tests.
- Multi-tenant isolation tests.
- Subscription billing tests.
- Order lifecycle tests.
- Inventory concurrency tests.
- Security tests.
- Frontend component tests.
- End-to-end checkout tests.

Important scenarios:

1. Customer successfully pays.
2. Customer abandons checkout.
3. Duplicate webhook arrives.
4. Gateway reports failed payment.
5. Bank transfer remains unverified.
6. Seller updates stock.
7. Two customers attempt to buy the last available item.
8. Seller subscription expires.
9. Seller attempts to access another seller's records.
10. Veltrix notification fails.
11. Payment provider becomes unavailable.
12. Refund is initiated and reconciled.

Provide meaningful test coverage for all critical financial operations.

## 27. DEPLOYMENT

Prepare the platform for production deployment.

Include:

- Dockerfiles.
- Docker Compose for development.
- PostgreSQL configuration.
- Redis configuration.
- Nginx configuration.
- Environment variable templates.
- Database migration commands.
- Production build commands.
- Health-check endpoints.
- Structured logging.
- Error monitoring.
- Backup procedures.
- Deployment documentation.

Use separate development, staging and production environments.

Never commit production API credentials.

## 28. DEVELOPMENT METHODOLOGY

Do not attempt to generate the entire platform in one unstructured code dump.

Work in organised development phases.

Phase 1:
Architecture, repository structure, database schema, authentication and multi-tenancy.

Phase 2:
Seller registration, onboarding, subscription plans and dashboards.

Phase 3:
Products, inventory, storefronts and customer management.

Phase 4:
Order management and live-selling sessions.

Phase 5:
Payment abstraction and Paystack integration.

Phase 6:
Flutterwave and Bachs integrations.

Phase 7:
Direct bank transfer and reconciliation.

Phase 8:
Veltrix API integration.

Phase 9:
WhatsApp commerce automation and notifications.

Phase 10:
Analytics, logistics and reporting.

Phase 11:
Super-admin dashboard.

Phase 12:
Security audits, testing and deployment.

At the end of every phase:

- Explain what was implemented.
- List created and modified files.
- Run relevant tests.
- Fix errors before proceeding.
- Update documentation.
- Identify incomplete external integrations.
- Ensure previous functionality remains operational.

Do not claim an integration is complete until it has been tested against the relevant provider's sandbox or an approved test environment.

## 29. IMPORTANT IMPLEMENTATION RULES

1. Build actual working software, not just static UI screens.
2. Do not use hardcoded sample data as production functionality.
3. Use realistic demo seed data only in development environments.
4. Do not invent external API endpoints.
5. Consult official provider documentation before implementation.
6. Keep payment providers independent of the main business logic.
7. Keep Veltrix integration modular.
8. Maintain complete financial transaction records.
9. Implement tenant-level security throughout.
10. Make every module extensible.
11. Prioritise Nigerian payment and commerce requirements.
12. Use feature flags for integrations that are not yet approved.
13. Never expose secret credentials in frontend code.
14. Never mark unverified payments as successful.
15. Never sacrifice financial integrity for convenience.

## 30. FINAL DELIVERABLES

The completed project must include:

1. Complete frontend application.
2. Complete Node.js/NestJS backend.
3. PostgreSQL database schema.
4. Prisma migrations.
5. Authentication and multi-tenancy.
6. Seller dashboard.
7. Super-admin dashboard.
8. Product and inventory management.
9. Online storefront.
10. Order management.
11. Live-selling management.
12. Paystack integration.
13. Flutterwave integration.
14. Bachs integration.
15. Direct bank transfer functionality.
16. Payment reconciliation.
17. Veltrix API integration.
18. WhatsApp ordering automation.
19. Subscription billing.
20. Analytics and reports.
21. API documentation.
22. Automated tests.
23. Docker deployment configuration.
24. Environment configuration templates.
25. Installation and deployment documentation.

The final result should be a scalable, commercially viable, secure and production-ready social commerce SaaS platform.

# FINAL PRODUCT VISION

LiveSell Africa should become the central operating system for businesses selling through social media.

A seller should be able to go live on TikTok, Instagram or Facebook, showcase products, receive customer orders, collect payments, communicate with buyers and dispatch orders without juggling multiple disconnected applications.

**One platform. Multiple sales channels. One complete commerce management system.**

Build for Nigeria first. Design for Africa. Scale globally.
