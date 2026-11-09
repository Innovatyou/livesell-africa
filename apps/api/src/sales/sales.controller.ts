import { Body, Controller, Get, HttpCode, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, Public, RequirePlatformRole } from '../common/auth/decorators';
import type { AuthUser } from '../common/auth/request-context';
import { SalesInquiryStatus } from '../generated/prisma/client';
import { CreateSalesInquiryDto, UpdateSalesInquiryDto } from './sales.dto';
import { SalesService } from './sales.service';

/** Five enquiries per IP per hour is plenty for a person and useless for a spammer. */
const INQUIRY_LIMIT = { default: { limit: Number(process.env.SALES_INQUIRY_LIMIT ?? 5), ttl: 3_600_000 } };

@ApiTags('sales')
@Controller({ path: 'sales-inquiries', version: '1' })
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Public() @Throttle(INQUIRY_LIMIT) @Post() @HttpCode(202)
  @ApiOperation({ summary: 'Contact sales (custom / Enterprise pricing). Public, rate limited' })
  create(@Body() dto: CreateSalesInquiryDto, @Req() req: Request) {
    return this.sales.create(dto, { ip: req.ip, userAgent: req.header('user-agent') });
  }
}

@ApiTags('admin · sales')
@ApiBearerAuth()
@RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT')
@Controller({ path: 'admin/sales-inquiries', version: '1' })
export class AdminSalesController {
  constructor(private readonly sales: SalesService) {}

  @Get() @ApiQuery({ name: 'status', enum: SalesInquiryStatus, required: false })
  list(@Query('status', new ParseEnumPipe(SalesInquiryStatus, { optional: true })) status?: SalesInquiryStatus) {
    return this.sales.list(status);
  }

  @Patch(':id') @ApiOperation({ summary: 'Update status / notes' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSalesInquiryDto, @CurrentUser() u: AuthUser) {
    return this.sales.update(id, dto, u.id);
  }
}
