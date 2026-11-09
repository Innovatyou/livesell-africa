import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CryptoService } from '../common/crypto/crypto.service';
import { DeliveryService } from '../logistics/delivery.service';
import { InsufficientStockError } from '../inventory/inventory.service';
import { CheckoutDto } from '../orders/orders.dto';
import { OrdersService } from '../orders/orders.service';
import { StorefrontPayDto, StorefrontReceiptUploadDto, StorefrontTransferClaimDto } from '../payments/payments.dto';
import { BankTransferService } from '../payments/bank-transfer.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorefrontPublicService } from './storefront-public.service';

/**
 * Public checkout (MASTER-SPEC §10/§25 `POST /store/:slug/checkout`) and order tracking.
 * Prices come from the database, never from the client. Stock is reserved at once; the order awaits payment and
 * is cancelled automatically if not paid before its hold expires. Customers track the order with a private link
 * (random token; only its hash is stored).
 */
@Injectable()
export class StorefrontCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly store: StorefrontPublicService,
    private readonly crypto: CryptoService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryService,
    private readonly transfers: BankTransferService,
  ) {}

  async checkout(slug: string, dto: CheckoutDto) {
    if (dto.website) throw new BadRequestException('Your order could not be placed'); // honeypot
    const tenant = await this.store.resolveTenant(slug);
    const pickup = dto.deliveryMethod === 'PICKUP';
    // The fee comes from the store's zones, never from the client.
    const price = await this.delivery.priceFor(tenant.id, pickup ? 'PICKUP' : 'DELIVERY', pickup || !dto.shippingAddress ? null : dto.shippingAddress);
    const token = this.crypto.randomToken(24);
    let order: { id: string; reference: string };
    try {
      order = await this.orders.create(
        tenant.id,
        { customer: dto.customer, items: dto.items, ...(pickup ? {} : { shippingAddress: dto.shippingAddress }), notes: dto.notes, confirm: true },
        { actorId: null, source: 'storefront', trackingTokenHash: this.crypto.hashToken(token), trackingTokenEnc: this.crypto.encrypt(token, tenant.id), whatsappOptIn: dto.whatsappOptIn === true, delivery: price },
      );
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        const variants = await this.prisma.forTenant(tenant.id).productVariant.findMany({
          where: { id: { in: e.shortages.map((s) => s.variantId) } }, select: { id: true, name: true, product: { select: { name: true } } },
        });
        const names = new Map(variants.map((v) => [v.id, `${v.product.name}${v.name !== 'Default' ? ` (${v.name})` : ''}`]));
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK', message: 'Some items are no longer available in the quantity you chose',
          items: e.shortages.map((s) => ({ variantId: s.variantId, name: names.get(s.variantId) ?? 'Item', available: s.available })),
        });
      }
      if (e instanceof ForbiddenException) {
        throw new ConflictException({ code: 'STORE_UNAVAILABLE', message: "This store can't take online orders right now. Please message the seller." });
      }
      throw e;
    }
    return { reference: order.reference, trackingToken: token, order: await this.track(slug, order.reference, token) };
  }

  async track(slug: string, reference: string, token: string) {
    const tenant = await this.store.resolveTenant(slug, { allowUnpublished: true });
    if (!/^LS-[A-Z0-9]{6}$/i.test(reference) || !token || token.length > 100) throw new NotFoundException('Order not found');
    const o = await this.prisma.forTenant(tenant.id).order.findFirst({
      where: { reference: reference.toUpperCase(), trackingTokenHash: this.crypto.hashToken(token) },
      include: {
        items: { orderBy: { position: 'asc' }, select: { productName: true, productCode: true, variantName: true, quantity: true, unitPriceMinor: true, lineTotalMinor: true } },
        statusHistory: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
      },
    });
    if (!o) throw new NotFoundException('Order not found');
    const timeline: Array<{ status: string; at: Date }> = [];
    for (const h of o.statusHistory) if (timeline.at(-1)?.status !== h.toStatus) timeline.push({ status: h.toStatus, at: h.createdAt });
    return {
      reference: o.reference, status: o.status, paymentStatus: o.paymentStatus, currency: o.currency, createdAt: o.createdAt,
      holdExpiresAt: ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'].includes(o.status) ? o.reservationExpiresAt : null,
      items: o.items, subtotalMinor: o.subtotalMinor, discountMinor: o.discountMinor, deliveryFeeMinor: o.deliveryFeeMinor, totalMinor: o.totalMinor,
      shippingAddress: o.shippingAddress, timeline, delivery: await this.delivery.publicView(tenant.id, o.id),
      onlinePayment: o.status === 'PENDING_PAYMENT' ? await this.payments.availability(tenant.id) : { online: false, provider: null, testMode: null },
      bankTransfer: await this.transfers.trackingInfo(tenant.id, o.id, ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'].includes(o.status)),
      store: { businessName: tenant.businessName, slug: tenant.slug, whatsappNumber: tenant.storefront?.whatsappNumber ?? null, contactPhone: tenant.storefront?.contactPhone ?? null, orderInstructions: tenant.storefront?.orderInstructions ?? null },
    };
  }

  /** Delivery fee and pickup option for an address, for the checkout page to display (the order is priced again on submit). */
  async deliveryOptions(slug: string, state?: string, city?: string) {
    const tenant = await this.store.resolveTenant(slug);
    return this.delivery.options(tenant.id, state && city ? { state: state.slice(0, 80), city: city.slice(0, 80) } : null);
  }

  async pay(slug: string, reference: string, dto: StorefrontPayDto) {
    const tenant = await this.store.resolveTenant(slug, { allowUnpublished: true });
    return this.payments.startStorefrontPayment(tenant.id, reference, dto.token, dto.email);
  }

  async reportTransfer(slug: string, reference: string, dto: StorefrontTransferClaimDto) {
    if (dto.website) throw new BadRequestException('Your report could not be sent'); // honeypot
    const tenant = await this.store.resolveTenant(slug, { allowUnpublished: true });
    const { token, website: _w, ...claim } = dto;
    return this.transfers.customerClaim(tenant.id, reference, token, claim);
  }

  async transferReceiptUrl(slug: string, reference: string, dto: StorefrontReceiptUploadDto) {
    const tenant = await this.store.resolveTenant(slug, { allowUnpublished: true });
    return this.transfers.customerReceiptUrl(tenant.id, reference, dto.token, dto.contentType, dto.contentLength);
  }
}
