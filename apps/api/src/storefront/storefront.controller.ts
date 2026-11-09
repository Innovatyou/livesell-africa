import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CheckoutDto } from '../orders/orders.dto';
import { StorefrontPayDto, StorefrontReceiptUploadDto, StorefrontTransferClaimDto } from '../payments/payments.dto';
import { StorefrontCheckoutService } from './storefront-checkout.service';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { CurrentTenant, CurrentUser, Public, RequirePermissions, TenantScoped } from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { ConfirmUploadDto, UploadRequestDto } from '../onboarding/onboarding.dto';
import { ACCENT_COLOURS, StorefrontAdminService } from './storefront-admin.service';
import { StorefrontPublicService } from './storefront-public.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateStorefrontDto {
  @ApiPropertyOptional({ nullable: true, example: 'Send the product code (e.g. BAG001) to our WhatsApp to order.' })
  @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(trim) @IsString() @MaxLength(500) orderInstructions?: string | null;
  @ApiPropertyOptional({ enum: ACCENT_COLOURS }) @IsOptional() @IsIn(ACCENT_COLOURS) accentColor?: string;
}

export class PublicProductsQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) search?: string;
  @IsOptional() @Matches(/^[a-z0-9-]{1,80}$/) category?: string;
  @IsOptional() @IsIn(['newest', 'price_asc', 'price_desc']) sort?: 'newest' | 'price_asc' | 'price_desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(48) pageSize?: number;
}

@ApiTags('storefront (seller)')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ path: 'storefront', version: '1' })
export class StorefrontAdminController {
  constructor(private readonly admin: StorefrontAdminService) {}

  @TenantScoped() @Get() @ApiOperation({ summary: 'Storefront settings, public link and publishing checklist' })
  get(@CurrentTenant() t: TenantContext) {
    return this.admin.get(t);
  }

  @RequirePermissions('store:manage') @Patch() @ApiOperation({ summary: 'Order instructions and accent colour' })
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: UpdateStorefrontDto) {
    return this.admin.update(t, u, dto);
  }

  @RequirePermissions('store:manage') @Post('cover/upload-url') @ApiOperation({ summary: 'Presigned PUT for a cover image (PNG/JPG/WebP ≤ 3 MB)' })
  coverUpload(@CurrentTenant() t: TenantContext, @Body() dto: UploadRequestDto) {
    return this.admin.presignCover(t.tenantId, dto.contentType, dto.contentLength);
  }

  @RequirePermissions('store:manage') @Put('cover')
  setCover(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: ConfirmUploadDto) {
    return this.admin.setCover(t, u, dto.key);
  }

  @RequirePermissions('store:manage') @Delete('cover')
  removeCover(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.admin.setCover(t, u, null);
  }

  @RequirePermissions('store:manage') @Post('publish') @HttpCode(200)
  @ApiOperation({ summary: 'Publish the storefront (needs a description, a contact number and an active product)' })
  publish(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.admin.setPublished(t, u, true);
  }

  @RequirePermissions('store:manage') @Post('unpublish') @HttpCode(200)
  unpublish(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.admin.setPublished(t, u, false);
  }
}

@ApiTags('storefront (public)')
@Public()
@Controller({ path: 'store', version: '1' })
export class StorefrontPublicController {
  constructor(private readonly store: StorefrontPublicService, private readonly checkoutService: StorefrontCheckoutService) {}

  @Get(':slug') @ApiOperation({ summary: 'Public store profile' })
  get(@Param('slug') slug: string) {
    return this.store.store(slug);
  }

  @Get(':slug/products') @ApiOperation({ summary: 'Public catalogue: active products only, with search, category and price sort' })
  products(@Param('slug') slug: string, @Query() q: PublicProductsQuery) {
    return this.store.products(slug, q);
  }

  @Get(':slug/products/:productSlug') @ApiOperation({ summary: 'Public product page' })
  product(@Param('slug') slug: string, @Param('productSlug') productSlug: string) {
    return this.store.product(slug, productSlug.slice(0, 80));
  }

  @Get(':slug/code/:code') @ApiOperation({ summary: 'Find a product by its code (e.g. BAG001), as announced in a live session' })
  byCode(@Param('slug') slug: string, @Param('code') code: string) {
    return this.store.productByCode(slug, code.slice(0, 40));
  }

  @Get(':slug/delivery-options') @ApiOperation({ summary: 'Delivery fee for an address (by zone) and whether pickup is offered' })
  deliveryOptions(@Param('slug') slug: string, @Query('state') state?: string, @Query('city') city?: string) {
    return this.checkoutService.deliveryOptions(slug, state, city);
  }

  @Throttle({ default: { limit: Number(process.env.CHECKOUT_LIMIT ?? 10), ttl: 3_600_000 } }) @Post(':slug/checkout')
  @ApiOperation({ summary: 'Place an order: prices from the database, stock reserved, returns a private tracking token (rate limited)' })
  checkout(@Param('slug') slug: string, @Body() dto: CheckoutDto) {
    return this.checkoutService.checkout(slug, dto);
  }

  @Throttle({ default: { limit: Number(process.env.CHECKOUT_LIMIT ?? 10) * 3, ttl: 3_600_000 } }) @Post(':slug/orders/:reference/pay') @HttpCode(200)
  @ApiOperation({ summary: 'Pay an order online: returns a Paystack checkout link (private tracking token required)' })
  pay(@Param('slug') slug: string, @Param('reference') reference: string, @Body() dto: StorefrontPayDto) {
    return this.checkoutService.pay(slug, reference, dto);
  }

  @Throttle({ default: { limit: Number(process.env.CHECKOUT_LIMIT ?? 10) * 2, ttl: 3_600_000 } }) @Post(':slug/orders/:reference/transfer/receipt-url') @HttpCode(200)
  @ApiOperation({ summary: 'Presigned PUT for a bank-transfer receipt (private token required)' })
  transferReceipt(@Param('slug') slug: string, @Param('reference') reference: string, @Body() dto: StorefrontReceiptUploadDto) {
    return this.checkoutService.transferReceiptUrl(slug, reference, dto);
  }

  @Throttle({ default: { limit: Number(process.env.CHECKOUT_LIMIT ?? 10), ttl: 3_600_000 } }) @Post(':slug/orders/:reference/transfer') @HttpCode(200)
  @ApiOperation({ summary: 'Tell the seller you paid by bank transfer. The seller checks their bank before the order is marked paid.' })
  reportTransfer(@Param('slug') slug: string, @Param('reference') reference: string, @Body() dto: StorefrontTransferClaimDto) {
    return this.checkoutService.reportTransfer(slug, reference, dto);
  }

  @Get(':slug/orders/:reference') @ApiOperation({ summary: 'Track an order with its private token' })
  track(@Param('slug') slug: string, @Param('reference') reference: string, @Query('token') token: string) {
    return this.checkoutService.track(slug, reference, String(token ?? ''));
  }
}
