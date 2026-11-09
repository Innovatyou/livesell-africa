import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { deliverSession } from '../auth/session-delivery';
import {
  AllowInactiveSubscription, CurrentTenant, CurrentUser, Public, RequirePermissions,
} from '../common/auth/decorators';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { Env } from '../config/env';
import { AcceptInvitationNewUserDto, CreateInvitationDto, InvitationTokenDto, UpdateMemberDto } from './staff.dto';
import { StaffService } from './staff.service';

const AUTH_LIMIT = { default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 } };
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.header('user-agent') });

@ApiTags('staff')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@RequirePermissions('staff:manage')
@Controller({ path: 'staff', version: '1' })
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get('invitations') @ApiOperation({ summary: 'Pending and expired invitations' })
  list(@CurrentTenant() t: TenantContext) {
    return this.staff.listInvitations(t.tenantId);
  }

  @Post('invitations') @ApiOperation({ summary: 'Invite a team member by email (counts against the plan seat limit)' })
  invite(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Body() dto: CreateInvitationDto, @Req() req: Request) {
    return this.staff.invite(t, u, dto, meta(req));
  }

  @Post('invitations/:id/resend') @HttpCode(200) @ApiOperation({ summary: 'Send the invitation again with a new link' })
  resend(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resend(t, u, id);
  }

  @AllowInactiveSubscription() @Delete('invitations/:id') @HttpCode(204) @ApiOperation({ summary: 'Revoke a pending invitation' })
  async revoke(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.staff.revoke(t, u, id);
  }

  /** Disabling access is a security action, so it works even when the subscription has lapsed. */
  @AllowInactiveSubscription() @Patch('members/:id')
  @ApiOperation({ summary: "Change a member's role or disable/enable them (not the owner, not yourself)" })
  update(@CurrentTenant() t: TenantContext, @CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.staff.updateMember(t, u, id, dto);
  }
}

@ApiTags('invitations')
@Controller({ path: 'invitations', version: '1' })
export class InvitationsController {
  private readonly secure: boolean;
  constructor(private readonly staff: StaffService, config: ConfigService<Env, true>) {
    this.secure = config.get('COOKIE_SECURE', { infer: true });
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('lookup') @HttpCode(200)
  @ApiOperation({ summary: 'Describe an invitation from its token (token in body, never in the URL path)' })
  lookup(@Body() dto: InvitationTokenDto) {
    return this.staff.lookup(dto.token);
  }

  @ApiBearerAuth() @Throttle(AUTH_LIMIT) @Post('accept') @HttpCode(200)
  @ApiOperation({ summary: 'Accept as the signed-in user (email must match the invitation)' })
  accept(@CurrentUser() u: AuthUser, @Body() dto: InvitationTokenDto, @Req() req: Request) {
    return this.staff.acceptAsUser(u, dto.token, meta(req));
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('accept-new') @HttpCode(201)
  @ApiOperation({ summary: 'Create an account for the invited email, join the team and sign in' })
  async acceptNew(@Body() dto: AcceptInvitationNewUserDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, tenant, tokens } = await this.staff.acceptAsNewUser(dto, meta(req));
    return { user, tenant, ...deliverSession(tokens, req, res, this.secure) };
  }
}
