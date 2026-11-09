import { Injectable } from '@nestjs/common';

/**
 * Logistics port (MASTER-SPEC §18 "integration with logistics providers through configurable adapters; do not
 * hardcode logistics providers"). Business logic talks to this interface only.
 *
 * Only the manual adapter exists today: the seller books the courier (or delivers, or the customer picks up) and
 * records the carrier, tracking reference and status by hand — §18 "allow sellers to update delivery statuses
 * manually where integrations are unavailable". A courier API adapter (booking, quotes, tracking webhooks) is added
 * here once a provider is chosen and its official documentation and sandbox credentials are available.
 */
export interface LogisticsCapabilities {
  /** Can book a pickup/shipment through the API. */
  booking: boolean;
  /** Can quote a price for an address. */
  quotes: boolean;
  /** Pushes or can be polled for tracking updates. */
  tracking: boolean;
}

export interface ShipmentRequest {
  orderReference: string;
  recipient: { name: string; phone: string | null; address: { line1: string; city: string; state: string; landmark?: string | null } };
  items: Array<{ name: string; quantity: number }>;
  idempotencyKey: string;
}

export interface ShipmentResult { trackingReference: string; carrierName: string }

export abstract class LogisticsProvider {
  abstract readonly code: string;
  abstract readonly name: string;
  abstract readonly capabilities: LogisticsCapabilities;
  /** Only when `capabilities.booking`. */
  createShipment?(req: ShipmentRequest): Promise<ShipmentResult>;
}

/** The seller handles delivery themselves and records it in LiveSell. */
export class ManualLogisticsAdapter extends LogisticsProvider {
  readonly code = 'manual';
  readonly name = 'Recorded by the seller';
  readonly capabilities: LogisticsCapabilities = { booking: false, quotes: false, tracking: false };
}

@Injectable()
export class LogisticsRegistry {
  private readonly providers = new Map<string, LogisticsProvider>();

  constructor() {
    for (const p of [new ManualLogisticsAdapter()]) this.providers.set(p.code, p);
  }

  get(code: string): LogisticsProvider | null {
    return this.providers.get(code) ?? null;
  }

  list() {
    return [...this.providers.values()].map((p) => ({ code: p.code, name: p.name, capabilities: p.capabilities }));
  }
}
