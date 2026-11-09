/** Shapes returned by the LiveSell API. Money fields are kobo strings. */

export interface Membership {
  id: string;
  role: { key: string; name: string };
  tenant: { id: string; slug: string; businessName: string; status: string };
}

export interface Me {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  status: string;
  platformRole: 'NONE' | 'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT';
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  memberships: Membership[];
}

export interface Workspace {
  id: string;
  slug: string;
  businessName: string;
  businessType: string;
  status: string;
  defaultCurrency: string;
  verifiedAt: string | null;
  role: string;
  permissions: string[];
  subscriptions: Array<{ status: SubscriptionStatus; currentPeriodEnd: string; trialEndsAt: string | null; plan: { code: string; name: string } }>;
}

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';
export type Interval = 'MONTHLY' | 'ANNUAL';

export interface PlanLimits { products: number | null; ordersPerMonth: number | null; staff: number | null; paymentGateways: number | null }

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  currency: string;
  monthlyPriceMinor: string | null;
  annualPriceMinor: string | null;
  trialDays: number;
  limits: PlanLimits;
  features: Record<string, boolean | string>;
  pricingModel: PricingModel;
  /** Basis points charged on each verified sale (COMMISSION plans only). */
  commissionBps: number | null;
}

export type PricingModel = 'SUBSCRIPTION' | 'COMMISSION';

export interface Invoice {
  id: string;
  number: string;
  kind: 'TRIAL_CONVERSION' | 'RENEWAL' | 'UPGRADE' | 'REACTIVATION' | 'COMMISSION';
  description: string | null;
  amountMinor: string;
  currency: string;
  status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  paidAt: string | null;
  plan: { code: string; name: string };
}

export interface BillingOverview {
  subscription: null | {
    id: string;
    status: SubscriptionStatus;
    interval: Interval;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    trialEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    endedAt: string | null;
    daysLeft: number;
    accessEndsAt: string | null;
    plan: Omit<Plan, 'description' | 'trialDays'>;
    pendingChange: null | { plan: Omit<Plan, 'description' | 'trialDays'>; interval: Interval; effectiveAt: string };
  };
  usage: { staff: number; products: number };
  limits: PlanLimits | null;
  openInvoices: Invoice[];
  commission: null | { bps: number; source: 'trial' | 'plan' | 'seller_override' | 'platform_default'; pricingModel: PricingModel };
  paymentCollectionEnabled: boolean;
}

export interface ChecklistItem { key: string; title: string; description: string; required: boolean; done: boolean; status?: string }
export interface Checklist { items: ChecklistItem[]; completed: number; total: number; requiredRemaining: number; percent: number }

export interface StoreProfile {
  id: string;
  slug: string;
  businessName: string;
  businessType: string;
  businessCategory: string | null;
  email: string;
  phone: string;
  country: string;
  state: string | null;
  city: string | null;
  address: string | null;
  verifiedAt: string | null;
  storefront: {
    description: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    whatsappNumber: string | null;
    socialLinks: Record<string, string>;
    isPublished: boolean;
    logoUrl: string | null;
  };
}

export interface PresignedUpload { key: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string; maxBytes: number }

export interface DashboardSummary {
  currency: string;
  timezone: string;
  salesTodayMinor: string;
  salesThisMonthMinor: string;
  totalOrders: number;
  paidOrders: number;
  pendingPayments: { count: number; amountMinor: string };
  cancelledOrders: number;
  outstandingOrders: number;
  productsSold: number;
  availableInventory: number;
  averageOrderValueMinor: string;
  topProducts: Array<{ productId: string; name: string; productCode: string; quantity: string; revenueMinor: string }>;
  recentCustomers: Array<{ id: string; fullName: string; phone: string | null; email: string | null; createdAt: string; orderCount: number; totalSpentMinor: string }>;
  recentTransactions: Array<{ id: string; reference: string; provider: string; grossMinor: string; currency: string; status: string; createdAt: string; verifiedAt: string | null; order: { id: string; reference: string } | null }>;
}

export type ChartPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';
export interface SalesChart { period: ChartPeriod; currency: string; timezone: string; totalMinor: string; points: Array<{ label: string; amountMinor: string; payments: number }> }

export interface Member { id: string; status: 'ACTIVE' | 'INVITED' | 'DISABLED'; createdAt: string; role: { key: string; name: string }; user: { id: string; fullName: string; email: string } }
export interface Invitation { id: string; email: string; roleKey: string; status: 'PENDING' | 'EXPIRED'; expiresAt: string; createdAt: string }

// ── Phase 3: catalogue, inventory, customers, storefront ──

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export interface Category { id: string; name: string; slug: string; parentId: string | null; sortOrder: number; _count: { products: number } }
export interface MediaItem { type: 'image' | 'video'; key: string; alt?: string; url: string; sortOrder: number }

export interface Variant {
  id: string; sku: string; name: string; attributes: Record<string, string>; priceMinor: string; promoPriceMinor: string | null;
  costPriceMinor: string | null; isDefault: boolean; isActive: boolean; inventory: { onHand: number; reserved: number; available: number };
}

export interface Product {
  id: string; name: string; slug: string; productCode: string; description: string | null; status: ProductStatus; currency: string;
  tags: string[]; media: MediaItem[]; weightGrams: number | null; dimensionsMm: { l: number; w: number; h: number } | null;
  lowStockThreshold: number; category: { id: string; name: string } | null; variants: Variant[];
  options: Array<{ name: string; values: string[] }>; priceMinMinor: string | null; priceMaxMinor: string | null;
  stock: { available: number; lowStock: boolean; outOfStock: boolean }; createdAt: string; updatedAt: string;
}

export interface ProductListItem {
  id: string; name: string; slug: string; productCode: string; status: ProductStatus; tags: string[]; categoryId: string | null;
  categoryName: string | null; variantCount: number; priceMin: string | null; priceMax: string | null; available: number;
  lowStock: boolean; outOfStock: boolean; thumbnailUrl: string | null; createdAt: string;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export interface Movement {
  id: string; type: 'RESTOCK' | 'ADJUSTMENT' | 'RESERVATION' | 'RELEASE' | 'SALE' | 'RETURN'; quantity: number; reason: string | null;
  orderId: string | null; onHandAfter: number | null; reservedAfter: number | null; createdAt: string;
  inventory: { variant: { id: string; sku: string; name: string } };
}
export interface LowStockRow { variantId: string; sku: string; variantName: string; productId: string; productName: string; productCode: string; onHand: number; reserved: number; available: number; threshold: number }

export interface ImportSummary { dryRun: boolean; rows: number; productsCreated: number; productsUpdated: number; variantsCreated: number; variantsUpdated: number }

export type CustomerSegment = 'all' | 'repeat' | 'new' | 'vip' | 'inactive' | 'outstanding' | 'opted_in';
export interface CustomerListItem {
  id: string; fullName: string; phone: string | null; email: string | null; whatsappOptIn: boolean; tags: string[]; createdAt: string;
  anonymizedAt: string | null; orderCount: number; paidCount: number; totalSpentMinor: string; outstanding: number;
  lastOrderAt: string | null; vip: boolean; repeat: boolean;
}
export interface Address { id: string; label: string | null; line1: string; line2: string | null; city: string; state: string; country: string; landmark: string | null; isDefault: boolean }
export interface Customer {
  id: string; fullName: string; phone: string | null; email: string | null; whatsappOptIn: boolean; optInAt: string | null; tags: string[];
  notes: string | null; createdAt: string; anonymizedAt: string | null; addresses: Address[];
  stats: { orderCount: number; paidCount: number; totalSpentMinor: string; outstanding: number; lastOrderAt: string | null; firstOrderAt: string | null; repeat: boolean; vip: boolean };
  orders: Array<{ id: string; reference: string; status: string; paymentStatus: string; totalMinor: string; currency: string; createdAt: string }>;
}

export interface StorefrontSettings {
  isPublished: boolean; publicUrl: string; orderInstructions: string | null; theme: { accentColor?: string }; accentColours: string[];
  coverUrl: string | null; readiness: Array<{ key: string; label: string; done: boolean }>;
}

export type Availability = 'in_stock' | 'low_stock' | 'out_of_stock';
export interface PublicStore {
  slug: string; businessName: string; verified: boolean; city: string | null; state: string | null; currency: string; description: string | null;
  orderInstructions: string | null; whatsappNumber: string | null; contactPhone: string | null; contactEmail: string | null;
  socialLinks: Record<string, string>; accentColor: string | null; logoUrl: string | null; coverUrl: string | null;
  categories: Array<{ name: string; slug: string }>;
}
export interface PublicProductCard { name: string; slug: string; productCode: string; category: string | null; priceMinor: string; compareAtMinor: string | null; availability: Availability; imageUrl: string | null }
export interface PublicProduct {
  name: string; slug: string; productCode: string; description: string | null; category: { name: string; slug: string } | null; tags: string[];
  currency: string; media: Array<{ type: 'image' | 'video'; alt: string; url: string }>;
  variants: Array<{ id: string; name: string; sku: string; attributes: Record<string, string>; priceMinor: string; compareAtMinor: string | null; availability: Availability; onlyLeft?: number }>;
  options: Array<{ name: string; values: string[] }>;
}

// ── Phase 4: orders and live selling ──

export type OrderStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAYMENT_VERIFICATION' | 'PAID' | 'PROCESSING' | 'READY_FOR_DISPATCH' | 'DISPATCHED' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

export interface OrderListItem {
  id: string; reference: string; status: OrderStatus; paymentStatus: string; fulfilmentStatus: string; totalMinor: string; currency: string;
  createdAt: string; reservationExpiresAt: string | null; customer: { id: string; fullName: string; phone: string | null } | null;
  channel: { type: string; name: string } | null; liveSession: { id: string; title: string } | null; _count: { items: number };
}

export interface OrderItem { id: string; variantId: string; productName: string; productCode: string | null; variantName: string; sku: string; quantity: number; unitPriceMinor: string; discountMinor: string; lineTotalMinor: string; position: number }
export interface ShippingAddress { fullName?: string | null; phone?: string | null; line1: string; line2?: string | null; city: string; state: string; landmark?: string | null; country?: string }

export interface Order {
  id: string; reference: string; status: OrderStatus; paymentStatus: string; fulfilmentStatus: string; currency: string;
  subtotalMinor: string; discountMinor: string; deliveryFeeMinor: string; totalMinor: string; notes: string | null;
  shippingAddress: ShippingAddress | null; reservationExpiresAt: string | null; createdAt: string; updatedAt: string;
  items: OrderItem[]; customer: { id: string; fullName: string; phone: string | null; email: string | null; anonymizedAt: string | null } | null;
  channel: { id: string; type: string; name: string } | null; liveSession: { id: string; title: string; status: string } | null;
  statusHistory: Array<{ id: string; fromStatus: OrderStatus | null; toStatus: OrderStatus; note: string | null; actorType: string; actorName: string | null; createdAt: string }>;
  transactions: PaymentTxn[];
  nextStatuses: OrderStatus[]; editable: boolean; canExtendHold: boolean;
}

export interface SalesChannel { id: string; type: string; name: string; handle: string | null; isActive: boolean; _count: { orders: number; liveSessions: number } }
export type LiveStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
export interface LiveSessionListItem {
  id: string; title: string; status: LiveStatus; scheduledAt: string; startedAt: string | null; endedAt: string | null; peakViewers: number | null;
  channel: { id: string; type: string; name: string }; _count: { products: number; orders: number }; paidOrders: number; revenueMinor: string;
}
export interface LiveSession {
  id: string; title: string; status: LiveStatus; description: string | null; orderInstructions: string | null; scheduledAt: string;
  startedAt: string | null; endedAt: string | null; peakViewers: number | null; channel: { id: string; type: string; name: string; handle: string | null };
  products: Array<{ productId: string; sessionPriceMinor: string | null; sortOrder: number; product: { id: string; name: string; productCode: string; status: string; deletedAt: string | null; variants: Array<{ id: string; sku: string; name: string; priceMinor: string; promoPriceMinor: string | null; available: number }> } }>;
  moderators: Array<{ memberId: string; name: string; role: string }>;
}
export interface LiveReport {
  session: { id: string; title: string; status: LiveStatus; channel: { name: string; type: string }; scheduledAt: string; startedAt: string | null; endedAt: string | null; peakViewers: number | null };
  durationMinutes: number | null; orders: { total: number; paid: number; awaitingPayment: number; cancelled: number };
  revenueMinor: string; awaitingPaymentMinor: string; unitsSold: number; averageOrderValueMinor: string; uniqueCustomers: number;
  paymentCompletionBps: number | null; cancellationBps: number | null;
  topProducts: Array<{ productCode: string | null; name: string; quantity: number; revenueMinor: string }>; viewerData: 'not_provided' | 'seller_reported';
}

export interface TrackedOrder {
  reference: string; status: OrderStatus; paymentStatus: string; currency: string; createdAt: string; holdExpiresAt: string | null;
  items: Array<{ productName: string; productCode: string | null; variantName: string; quantity: number; unitPriceMinor: string; lineTotalMinor: string }>;
  subtotalMinor: string; discountMinor: string; deliveryFeeMinor: string; totalMinor: string; shippingAddress: ShippingAddress | null;
  timeline: Array<{ status: OrderStatus; at: string }>;
  store: { businessName: string; slug: string; whatsappNumber: string | null; contactPhone: string | null; orderInstructions: string | null };
  onlinePayment: { online: boolean; provider: string | null; providerName?: string | null; testMode: boolean | null };
  bankTransfer?: { accounts: PublicTransferAccount[]; claims: Array<{ reference: string; status: 'AWAITING_CHECK' | 'VERIFIED' | 'NOT_FOUND'; reportedAt: string }> };
  delivery?: PublicDelivery | null;
}

// ───────────────────────── Payments (Phase 5) ─────────────────────────
export type TxnStatus = 'INITIALIZED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED' | 'REVERSED';
export type RefundStatus = 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
export interface PaymentTxn {
  id: string; reference: string; provider: string; status: TxnStatus; grossMinor: string; currency: string;
  providerFeeMinor: string | null; platformCommissionMinor: string; sellerProceedsMinor: string | null; settlementMode: 'DIRECT' | 'SPLIT' | 'BANK_TRANSFER' | null;
  failureReason: string | null; verifiedAt: string | null; verifiedBy?: string | null; createdAt: string;
  transferEvidence?: TransferEvidence | null;
  refunds: Array<{ id: string; amountMinor: string; currency: string; status: RefundStatus; reason: string | null; createdAt: string }>;
}
export interface PaymentLink { reference: string; checkoutUrl: string; amountMinor: string; currency: string; provider: string; reused: boolean }
export type OnlineProvider = 'PAYSTACK' | 'FLUTTERWAVE' | 'BACHS';
export interface ProviderSetting {
  provider: { code: OnlineProvider; name: string; enabled: boolean };
  splitAvailable: boolean; webhooksEnabled: boolean;
  capabilities: { split: boolean; multipleRefunds: boolean; minRefundMinor: string; webhookSecret: 'secret_key' | 'separate'; requiresPublicCallback: boolean };
  commission?: { bps: number; source: string; pricingModel: string } | null;
  account: null | {
    id: string; mode: 'DIRECT' | 'SPLIT'; isActive: boolean; isDefault: boolean; testMode: boolean; publicKey: string | null; hasSecretKey: boolean; hasWebhookSecret: boolean;
    subaccountCode: string | null; lastVerifiedAt: string | null; bankAccount: { bankName: string; accountName: string; last4: string } | null; webhookUrl: string | null;
  };
}
export interface PaymentSettings {
  commission: { bps: number; source: string; pricingModel: string } | null;
  defaultProvider: OnlineProvider | null;
  providers: ProviderSetting[];
}
export interface PaymentStatusResult {
  status: TxnStatus; amountMinor: string; currency: string; provider: string; providerDown: boolean; kind: 'order' | 'subscription';
  orderReference: string | null; store: { slug: string; businessName: string } | null;
}
export interface TransactionList {
  items: Array<Omit<PaymentTxn, 'refunds'> & { order: { id: string; reference: string } | null; refunds: Array<{ amountMinor: string; status: RefundStatus }> }>;
  total: number; page: number; pageSize: number;
}

// ───────────────────────── Bank transfer & reconciliation (Phase 7) ─────────────────────────
export interface TransferEvidence {
  payerName: string; payerBank?: string | null; payerReference?: string | null; amountClaimedMinor?: string | null; receiptKey?: string | null;
  submittedBy: 'customer' | 'staff'; submittedAt: string;
  decision?: { by: string; at: string; outcome: 'VERIFIED' | 'REJECTED'; reason?: string | null; amountReceivedMinor?: string | null };
}
export interface PublicTransferAccount { id: string; bankName: string; accountName: string; accountNumber: string; instructions: string | null; nameVerified: boolean }
export interface TransferAccount extends Omit<PublicTransferAccount, 'instructions'> {
  bankCode: string | null; last4: string; transferInstructions: string | null; isActive: boolean; isDefault: boolean; createdAt: string; nameMismatch?: boolean;
}
export interface PendingTransfer {
  id: string; reference: string; grossMinor: string; currency: string; payerName: string; payerReference: string | null; hasReceipt: boolean; createdAt: string;
  order: { id: string; reference: string; status: OrderStatus; reservationExpiresAt: string | null; customer: { fullName: string } | null } | null;
}
export interface ReconIssue { type: string; severity: 'error' | 'warning'; reference: string | null; orderId: string | null; orderReference: string | null; detail: string }
export interface ReconReport {
  checkedAt: string; staleAfterHours: number;
  summary: { verifiedPayments: number; verifiedMinor: string; refundedMinor: string; unverifiedTransfers: number; unverifiedMinor: string; errors: number; warnings: number };
  issues: ReconIssue[];
}

// ───────────────────────── Messaging (Phase 8) ─────────────────────────
export type Channel = 'EMAIL' | 'SMS' | 'WHATSAPP';
export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';
export interface VeltrixStatus {
  configured: boolean; channels: Record<Channel, boolean>; account?: { name: string | null; email: string | null } | null;
  wallet?: { balance: string; currency: string | null } | null; error?: string; verify: { configured: boolean };
}
export interface MessagingSettings { prices: Record<Channel, number>; limits: Record<Channel, number>; defaults: { prices: Record<Channel, number>; limits: Record<Channel, number> } }
export interface PlatformUsage {
  period: string;
  stores: Array<{ tenantId: string; businessName: string; slug: string; messages: number; costMinor: string; channels: Record<string, number> }>;
  totals: { messages: number; costMinor: string; failed: number };
}
export interface NotificationItem {
  id: string; channel: Channel; type: string; destination: string; status: NotificationStatus; error: string | null; attempts: number; retryable: boolean;
  providerMessageId: string | null; sentAt: string | null; deliveredAt: string | null; createdAt: string; costMinor: string | null;
  store?: { businessName: string; slug: string } | null;
}
export interface NotificationList { items: NotificationItem[]; total: number; page: number; pageSize: number }
export interface MessagingUsage {
  period: string; currency: string; totalCostMinor: string;
  channels: Array<{ channel: Channel; limit: number; sent: number; delivered: number; failed: number; queued: number; billed: number; costMinor: string; enabled: boolean }>;
}

// ───────────── Phase 9: automatic order messages, WhatsApp ordering ─────────────
export type OrderEvent =
  | 'ORDER_PLACED' | 'PAYMENT_RECEIVED' | 'PAYMENT_REMINDER' | 'ABANDONED_CHECKOUT' | 'ORDER_DISPATCHED' | 'ORDER_DELIVERED'
  | 'ORDER_CANCELLED' | 'REFUND_COMPLETED' | 'TRANSFER_REPORTED' | 'TRANSFER_NOT_FOUND';
export interface EventChannels { whatsapp: boolean; sms: boolean; email: boolean }
export interface MessagePreferences {
  enabled: boolean;
  events: Record<OrderEvent, EventChannels>;
  paymentReminderHoursBefore: number;
  abandonedAfterMinutes: number;
}
export interface ReminderResult { sent: boolean; results: Array<{ channel: Channel; status: NotificationStatus; duplicate: boolean; error: string | null }> }
export interface WhatsappTemplateInfo { name: string; language: string; category: string; params: number; header: string | null; named?: boolean }
export interface WhatsappAdminSettings {
  channelEnabled: boolean;
  platformNumber: string | null;
  forwarding: { connected: boolean; url: string; connectedAt: string | null };
  events: Array<{ event: OrderEvent; params: string[]; template: { name: string; language: string } | null }>;
  approvedTemplates: WhatsappTemplateInfo[];
  approvedError: string | null;
}
export interface WhatsappOrdering { enabled: boolean; number: string | null; prefix: string }

// ───────────── Phase 10: logistics, analytics ─────────────
export type DeliveryMethod = 'PICKUP' | 'SELLER_DELIVERY' | 'THIRD_PARTY';
export type DeliveryStatus = 'PENDING' | 'ASSIGNED' | 'IN_TRANSIT' | 'DELIVERED' | 'FAILED' | 'RETURNED';
export interface DeliveryZone { id: string; name: string; states: string[]; cities: string[]; feeMinor: string; currency: string; etaDays: number | null; isActive: boolean; createdAt: string }
export interface DeliverySettings { pickupEnabled: boolean; pickupAddress: string | null; pickupInstructions: string | null; deliverOutsideZones: boolean }
export interface Courier { id: string; name: string; kind: 'RIDER' | 'COMPANY'; phone: string | null; notes: string | null; showPhoneToCustomer: boolean; isActive: boolean; _count?: { deliveries: number } }
export interface DeliverySettingsResponse { settings: DeliverySettings; zones: DeliveryZone[]; couriers: Courier[]; providers: Array<{ code: string; name: string; capabilities: { booking: boolean; quotes: boolean; tracking: boolean } }> }
export interface DeliveryOptions {
  delivery: { method: 'DELIVERY'; available: boolean; feeMinor: string | null; zone: { id: string; name: string; etaDays: number | null } | null; feeToBeAgreed: boolean };
  pickup: { available: boolean; address: string | null; instructions: string | null; feeMinor: string };
}
export interface OrderDelivery {
  orderId: string; orderStatus: OrderStatus; feeMinor: string; currency: string; hasAddress: boolean; shippable: boolean;
  delivery: {
    id: string; method: DeliveryMethod; status: DeliveryStatus; zoneId: string | null; zone: { id: string; name: string; etaDays: number | null } | null;
    courierId: string | null; courier: { id: string; name: string; kind: 'RIDER' | 'COMPANY'; phone: string | null; showPhoneToCustomer: boolean; isActive: boolean } | null;
    carrierName: string | null; trackingReference: string | null; dispatchNote: string | null; problemNote: string | null;
    dispatchedAt: string | null; deliveredAt: string | null; nextStatuses: DeliveryStatus[];
  } | null;
}
export interface PublicDelivery {
  method: DeliveryMethod; status: DeliveryStatus; carrierName: string | null; carrierPhone?: string | null; trackingReference: string | null; dispatchedAt: string | null; deliveredAt: string | null;
  zone: { name: string; etaDays: number | null } | null; pickupAddress: string | null; pickupInstructions: string | null;
}
export interface DeliveryBoardItem {
  id: string; reference: string; status: OrderStatus; totalMinor: string; deliveryFeeMinor: string; currency: string; createdAt: string; shippingAddress: ShippingAddress | null;
  customer: { fullName: string; phone: string | null } | null;
  delivery: { method: DeliveryMethod; status: DeliveryStatus; carrierName: string | null; trackingReference: string | null; dispatchedAt: string | null; deliveredAt: string | null; problemNote: string | null; zone: { name: string } | null } | null;
}

export interface Change<T = string | number> { previous: T; change: T; changeBps: number | null }
export interface AnalyticsOverview {
  orders: number; paidOrders: number; awaitingPayment: number; cancelledOrders: number;
  grossSalesMinor: string; refundsMinor: string; netSalesMinor: string; averageOrderValueMinor: string; unitsSold: number;
  paymentCompletionBps: number | null; cancellationBps: number | null; liveSessions: number; liveOrders: number;
  buyers: number; newCustomers: number; repeatBuyers: number; repeatPurchaseBps: number | null;
}
export interface AnalyticsReport {
  currency: string; timezone: string; range: { from: string; to: string; days: number; bucket: 'day' | 'week' | 'month' };
  previousRange: { from: string; to: string }; channel: { id: string; name: string; type: string } | null;
  overview: AnalyticsOverview;
  comparison: {
    orders: Change<number>; paidOrders: Change<number>; grossSalesMinor: Change<string>; netSalesMinor: Change<string>; averageOrderValueMinor: Change<string>;
    unitsSold: Change<number>; newCustomers: Change<number>; paymentCompletionBps: { previous: number | null }; cancellationBps: { previous: number | null };
  };
  series: Array<{ label: string; orders: number; paidOrders: number; grossSalesMinor: string }>;
  channels: Array<{ channelId: string | null; name: string; type: string | null; orders: number; paidOrders: number; cancelledOrders: number; grossSalesMinor: string; averageOrderValueMinor: string; paymentCompletionBps: number | null; cancellationBps: number | null; newCustomers: number }>;
  sessions: Array<{ id: string; title: string; channel: string; startedAt: string; endedAt: string | null; durationMinutes: number | null; orders: number; paidOrders: number; cancelledOrders: number; grossSalesMinor: string; unitsSold: number; averageOrderValueMinor: string; paymentCompletionBps: number | null; buyers: number; peakViewers: number | null; conversionBps: number | null; viewerData: 'not_provided' | 'seller_reported' }>;
  topProducts: Array<{ productId: string; name: string; productCode: string; unitsSold: number; revenueMinor: string; orders: number }>;
  tier: 'standard' | 'advanced';
  limits: { maxDays: number; pdf: boolean; schedules: boolean };
  patterns: Array<{ weekday: number; hour: number; orders: number; paidOrders: number; grossSalesMinor: string }> | null;
  topCustomers: Array<{ customerId: string; name: string; paidOrders: number; spendMinor: string; newInRange: boolean }> | null;
}
export interface ReportSchedules {
  available: boolean;
  schedules: Array<{ id: string; frequency: 'WEEKLY' | 'MONTHLY'; recipientUserIds: string[]; isActive: boolean; lastPeriod: string | null }>;
  recipients: Array<{ id: string; fullName: string; email: string }>;
}
export interface CommissionSummary {
  currency: string;
  rate: { bps: number; source: 'trial' | 'plan' | 'seller_override' | 'platform_default'; pricingModel: 'SUBSCRIPTION' | 'COMMISSION' } | null;
  thisMonthMinor: string; unbilledMinor: string; collectedAtSourceThisMonthMinor: string;
  nextInvoiceOn: string; minInvoiceMinor: string; dueDays: number; graceDays: number; writesBlocked: boolean;
  invoices: Array<{ id: string; number: string; description: string | null; amountMinor: string; status: 'OPEN' | 'PAID' | 'VOID' | 'DRAFT' | 'UNCOLLECTIBLE'; dueAt: string; paidAt: string | null; overdue: boolean }>;
}
