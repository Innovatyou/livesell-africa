import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../common/auth/decorators';
import type { AuthUser } from '../common/auth/request-context';
import { SendPhoneOtpDto, VerifyPhoneOtpDto } from './dto';
import { PhoneVerificationService } from './phone-verification.service';

const AUTH_LIMIT = { default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 } };

@ApiTags('auth')
@ApiBearerAuth()
@Controller({ path: 'auth/phone', version: '1' })
export class PhoneController {
  constructor(private readonly phone: PhoneVerificationService) {}

  @Throttle(AUTH_LIMIT) @Post('send-otp') @HttpCode(200)
  @ApiOperation({ summary: 'Send a 6-digit verification code by SMS (optionally setting a new phone number first)' })
  @ApiTooManyRequestsResponse({ description: 'Resend cooldown (60s) or hourly limit (5) reached' })
  send(@CurrentUser() user: AuthUser, @Body() dto: SendPhoneOtpDto, @Req() req: Request) {
    return this.phone.sendCode(user.id, dto.phone, { ip: req.ip, userAgent: req.header('user-agent') });
  }

  @Throttle(AUTH_LIMIT) @Post('verify') @HttpCode(200)
  @ApiOperation({ summary: 'Verify the phone number with the code (5 attempts per code)' })
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyPhoneOtpDto, @Req() req: Request) {
    return this.phone.verifyCode(user.id, dto.code, { ip: req.ip, userAgent: req.header('user-agent') });
  }
}
