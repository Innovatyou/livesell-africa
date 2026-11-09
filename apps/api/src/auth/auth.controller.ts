import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { CurrentUser, Public } from '../common/auth/decorators';
import type { AuthUser } from '../common/auth/request-context';
import { Env } from '../config/env';
import { AuthService } from './auth.service';
import { ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, ResetPasswordDto, TokenDto } from './dto';
import { deliverSession, REFRESH_COOKIE, refreshCookieOptions } from './session-delivery';
import { ClientMeta, TokenPair, TokenService } from './token.service';

export { REFRESH_COOKIE };
const AUTH_LIMIT = { default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 } };

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly cookieBase: CookieOptions;

  constructor(private readonly auth: AuthService, private readonly tokens: TokenService, config: ConfigService<Env, true>) {
    this.cookieBase = refreshCookieOptions(config.get('COOKIE_SECURE', { infer: true }));
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('register')
  @ApiOperation({ summary: 'Register a seller: creates user, workspace, system roles and trial' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, tenant, tokens } = await this.auth.register(dto, meta(req));
    return { user, tenant, ...this.deliver(tokens, req, res) };
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.deliver(await this.auth.login(dto, meta(req)), req, res);
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('refresh') @HttpCode(200)
  @ApiHeader({ name: 'X-Client-Type', required: false, description: '"mobile" to send/receive refresh token in body' })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const presented = req.cookies?.[REFRESH_COOKIE] ?? dto.refreshToken;
    if (!presented) throw new UnauthorizedException('No refresh token');
    try {
      return this.deliver(await this.tokens.rotate(presented, meta(req)), req, res);
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, this.cookieBase);
      throw e;
    }
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const presented = req.cookies?.[REFRESH_COOKIE] ?? dto.refreshToken;
    if (presented) await this.tokens.revokeByToken(presented);
    res.clearCookie(REFRESH_COOKIE, this.cookieBase);
  }

  @ApiBearerAuth() @Post('logout-all') @HttpCode(204)
  async logoutAll(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.tokens.revokeAllForUser(user.id);
    res.clearCookie(REFRESH_COOKIE, this.cookieBase);
  }

  @ApiBearerAuth() @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('verify-email') @HttpCode(204)
  async verifyEmail(@Body() dto: TokenDto) {
    await this.auth.verifyEmail(dto.token);
  }

  @ApiBearerAuth() @Throttle(AUTH_LIMIT) @Post('verify-email/resend') @HttpCode(202)
  async resend(@CurrentUser() user: AuthUser) {
    await this.auth.resendVerification(user.id);
    return { status: 'sent' };
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('forgot-password') @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.requestPasswordReset(dto.email, meta(req));
    return { status: 'If an account exists for that email, a reset link has been sent.' };
  }

  @Public() @Throttle(AUTH_LIMIT) @Post('reset-password') @HttpCode(204)
  async reset(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.newPassword, meta(req));
  }

  private deliver(t: TokenPair, req: Request, res: Response) {
    return deliverSession(t, req, res, this.cookieBase.secure ?? false);
  }
}

function meta(req: Request): ClientMeta {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}
