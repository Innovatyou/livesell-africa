import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { NotificationService } from '../notifications/notifications.service';
import { VeltrixAuthMailer } from '../notifications/veltrix-mailers';
import { AuthMailer, LogAuthMailer } from './auth-mailer';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PhoneController } from './phone.controller';
import { PhoneVerificationService } from './phone-verification.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController, PhoneController],
  providers: [
    AuthService, TokenService, PhoneVerificationService,
    // Veltrix when the platform account is configured; otherwise the development logger (sends nothing in production).
    {
      provide: AuthMailer,
      inject: [ConfigService, NotificationService],
      useFactory: (config: ConfigService<Env, true>, notifications: NotificationService) =>
        config.get('VELTRIX_ENABLED', { infer: true }) ? new VeltrixAuthMailer(notifications) : new LogAuthMailer(),
    },
  ],
  exports: [TokenService, AuthService, AuthMailer],
})
export class AuthModule {}
