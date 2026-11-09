import { Body, Controller, Delete, Get, HttpCode, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CurrentTenant, CurrentUser, RequirePermissions, RequirePlatformRole, TenantScoped,
} from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { BusinessVerificationStatus } from '../generated/prisma/client';
import {
  ConfirmUploadDto, RejectVerificationDto, SubmitVerificationDto, UpdateStoreProfileDto, UploadRequestDto,
} from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

@ApiTags('onboarding')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller({ version: '1' })
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @TenantScoped() @Get('onboarding')
  @ApiOperation({ summary: 'Guided onboarding checklist, computed from real data' })
  checklist(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    return this.onboarding.checklist(t, u);
  }

  @TenantScoped() @Get('store/profile') @ApiOperation({ summary: 'Business profile and storefront settings' })
  profile(@CurrentTenant() t: TenantContext) {
    return this.onboarding.profile(t.tenantId);
  }

  @RequirePermissions('store:manage') @Patch('store/profile') @ApiOperation({ summary: 'Update business profile / storefront contact details' })
  updateProfile(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: UpdateStoreProfileDto) {
    return this.onboarding.updateProfile(t, u, dto);
  }

  @RequirePermissions('store:manage') @Post('store/logo/upload-url')
  @ApiOperation({ summary: 'Presigned PUT for a logo (PNG/JPG/WebP ≤ 2 MB, 5-minute expiry, exact size signed)' })
  logoUploadUrl(@CurrentTenant() t: TenantContext, @Body() dto: UploadRequestDto) {
    return this.onboarding.presignLogo(t.tenantId, dto.contentType, dto.contentLength);
  }

  @RequirePermissions('store:manage') @Put('store/logo')
  @ApiOperation({ summary: 'Confirm the uploaded logo (HEAD + type sniffing) and set it' })
  setLogo(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: ConfirmUploadDto) {
    return this.onboarding.setLogo(t, u, dto.key);
  }

  @RequirePermissions('store:manage') @Delete('store/logo') @HttpCode(204) @ApiOperation({ summary: 'Remove the logo' })
  async removeLogo(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser) {
    await this.onboarding.removeLogo(t, u);
  }

  @RequirePermissions('store:manage') @Get('business-verification') @ApiOperation({ summary: 'Verification status and latest submission' })
  verification(@CurrentTenant() t: TenantContext) {
    return this.onboarding.verificationStatus(t.tenantId);
  }

  @RequirePermissions('store:manage') @Post('business-verification/upload-url')
  @ApiOperation({ summary: 'Presigned PUT for the registration certificate (PDF/PNG/JPG ≤ 5 MB, private)' })
  verificationUploadUrl(@CurrentTenant() t: TenantContext, @Body() dto: UploadRequestDto) {
    return this.onboarding.presignVerificationDocument(t.tenantId, dto.contentType, dto.contentLength);
  }

  @RequirePermissions('store:manage') @Post('business-verification')
  @ApiOperation({ summary: 'Submit for review (one pending request at a time)' })
  submitVerification(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: SubmitVerificationDto) {
    return this.onboarding.submitVerification(t, u, dto);
  }
}

@ApiTags('admin · business verification')
@ApiBearerAuth()
@Controller({ path: 'admin/business-verifications', version: '1' })
export class AdminVerificationController {
  constructor(private readonly onboarding: OnboardingService) {}

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get()
  @ApiQuery({ name: 'status', enum: BusinessVerificationStatus, required: false })
  list(@Query('status', new ParseEnumPipe(BusinessVerificationStatus, { optional: true })) status?: BusinessVerificationStatus) {
    return this.onboarding.adminList(status ?? 'PENDING');
  }

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Get(':id')
  @ApiOperation({ summary: 'Request detail with a short-lived link to the private document' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.onboarding.adminGet(id);
  }

  @RequirePlatformRole('PLATFORM_ADMIN', 'PLATFORM_SUPPORT') @Post(':id/registry-check') @HttpCode(200)
  registryCheck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    return this.onboarding.registryCheck(id, u.id);
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post(':id/approve') @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    return this.onboarding.adminDecide(id, u, 'APPROVED');
  }

  @RequirePlatformRole('PLATFORM_ADMIN') @Post(':id/reject') @HttpCode(200)
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Body() dto: RejectVerificationDto) {
    return this.onboarding.adminDecide(id, u, 'REJECTED', dto.reason);
  }
}
