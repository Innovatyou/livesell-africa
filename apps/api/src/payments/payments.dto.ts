import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { lower, trim } from '../auth/dto';

export class PayOrderDto {
  @ApiPropertyOptional({ description: "Customer's email for the Paystack receipt (required if the customer has none on file)" })
  @IsOptional() @Transform(lower) @IsEmail() @MaxLength(254) email?: string;
}

export class StorefrontPayDto extends PayOrderDto {
  @ApiProperty({ description: 'Private tracking token from checkout' }) @IsString() @MaxLength(100) token!: string;
}

export class RefundDto {
  @ApiPropertyOptional({ example: '500000', description: 'Kobo to refund; omit to refund everything not yet refunded' })
  @IsOptional() @Matches(/^[1-9]\d{0,12}$/, { message: 'Amount is whole kobo as a string, e.g. "150000" for ₦1,500' }) amountMinor?: string;
  @ApiPropertyOptional({ example: 'Item out of stock' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
  @ApiPropertyOptional({ description: 'Which payment to refund, when an order has more than one' }) @IsOptional() @IsUUID() transactionId?: string;
}

export class ConnectDirectDto {
  @ApiProperty({ description: 'Secret key (Paystack sk_…, Flutterwave FLWSECK…-X, Bachs sk_sandbox_/sk_live_…). Stored encrypted; never returned.' })
  @Transform(trim) @IsString() @MaxLength(200) secretKey!: string;
  @ApiPropertyOptional({ description: 'Public key (required for Paystack; optional for Flutterwave; not used by Bachs)' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) publicKey?: string;
  @ApiPropertyOptional({ description: 'Webhook signing secret (Flutterwave "secret hash" / Bachs endpoint signing secret). Stored encrypted; never returned.' })
  @IsOptional() @Transform(trim) @IsString() @Length(16, 200) webhookSecret?: string;
}

export class ConnectSplitDto {
  @ApiProperty({ example: '058', description: 'Bank code from GET /payments/banks' }) @Transform(trim) @Matches(/^[0-9A-Za-z-]{2,20}$/) bankCode!: string;
  @ApiProperty({ example: '0123456789', description: '10-digit NUBAN' }) @Transform(trim) @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number' }) accountNumber!: string;
}

export class SetActiveDto {
  @ApiProperty() @IsBoolean() isActive!: boolean;
}

export class VerifyReferenceDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9.=-]{8,100}$/) reference!: string;
}

export class TransactionsQuery {
  @IsOptional() @IsIn(['INITIALIZED', 'PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'REVERSED']) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class UpdateProviderDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sandboxMode?: boolean;
}

// ───────────────────────── Bank transfer (Phase 7) ─────────────────────────
const KOBO = /^[1-9]\d{0,12}$/;
const KOBO_MSG = 'Amount is whole kobo as a string, e.g. "150000" for ₦1,500';

export class CreateTransferAccountDto {
  @ApiPropertyOptional({ example: '058', description: 'Bank code from GET /payments/banks — lets us confirm the account name with the bank' })
  @IsOptional() @Transform(trim) @Matches(/^[0-9A-Za-z-]{2,20}$/) bankCode?: string;
  @ApiProperty({ example: 'Guaranty Trust Bank' }) @Transform(trim) @IsString() @Length(2, 80) bankName!: string;
  @ApiProperty({ example: '0123456789' }) @Transform(trim) @Matches(/^\d{10}$/, { message: 'Enter the 10-digit account number' }) accountNumber!: string;
  @ApiProperty({ example: 'ADA FASHION LTD' }) @Transform(trim) @IsString() @Length(2, 120) accountName!: string;
  @ApiPropertyOptional({ example: 'Use your order number (LS-…) as the transfer description.' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) transferInstructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateTransferAccountDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) transferInstructions?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class TransferClaimDto {
  @ApiProperty({ example: 'Amaka Nnaji', description: 'Name on the account the money was sent from' }) @Transform(trim) @IsString() @Length(2, 120) payerName!: string;
  @ApiPropertyOptional({ example: 'Access Bank' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(80) payerBank?: string;
  @ApiPropertyOptional({ example: '000013261106104115000821734502', description: 'Session ID / reference from the bank receipt' })
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) payerReference?: string;
  @ApiPropertyOptional({ example: '2500000', description: 'Amount sent, in kobo (for the seller to compare)' }) @IsOptional() @Matches(KOBO, { message: KOBO_MSG }) amountMinor?: string;
  @ApiPropertyOptional({ description: 'Key from the receipt upload URL, after uploading' }) @IsOptional() @IsString() @MaxLength(300) receiptKey?: string;
  @ApiPropertyOptional({ description: 'Which of the store’s accounts the money went to' }) @IsOptional() @IsUUID() bankAccountId?: string;
}

export class StorefrontTransferClaimDto extends TransferClaimDto {
  @ApiProperty() @IsString() @MaxLength(100) token!: string;
  @ApiPropertyOptional({ description: 'Leave empty' }) @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class ReceiptUploadDto {
  @ApiProperty({ enum: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] }) @IsIn(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) contentType!: string;
  @ApiProperty({ example: 120000 }) @Type(() => Number) @IsInt() @Min(1) @Max(5 * 1024 * 1024) contentLength!: number;
}

export class StorefrontReceiptUploadDto extends ReceiptUploadDto {
  @ApiProperty() @IsString() @MaxLength(100) token!: string;
}

export class VerifyTransferDto {
  @ApiProperty({ example: '2500000', description: 'The amount you can see in your bank account, in kobo' }) @Matches(KOBO, { message: KOBO_MSG }) amountReceivedMinor!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

export class RejectTransferDto {
  @ApiProperty({ example: 'No matching credit in our account' }) @Transform(trim) @IsString() @Length(3, 300) reason!: string;
}
