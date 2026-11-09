import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/auth/decorators';
import type { AuthUser } from '../common/auth/request-context';
import { PushService } from './push.service';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]' }) @IsString() @Length(20, 260) token!: string;
  @ApiProperty({ enum: ['ios', 'android'] }) @IsIn(['ios', 'android']) platform!: 'ios' | 'android';
  @ApiPropertyOptional({ example: 'Ada’s iPhone' }) @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}
export class UnregisterDeviceDto {
  @ApiProperty() @IsString() @Length(20, 260) token!: string;
}

/** The signed-in user's phones for push notifications (mobile app). Not store-scoped: one phone, every store. */
@ApiTags('push')
@ApiBearerAuth()
@Controller({ path: 'me/devices', version: '1' })
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get() @ApiOperation({ summary: 'Phones that get push notifications for this user' })
  list(@CurrentUser() u: AuthUser) {
    return this.push.devices(u.id);
  }

  @Post() @HttpCode(200) @ApiOperation({ summary: 'Register this phone (Expo push token) for new orders and transfer reports' })
  register(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.push.register(u.id, dto);
  }

  @Delete() @ApiOperation({ summary: 'Stop push notifications on this phone (sign-out or switched off)' })
  unregister(@CurrentUser() u: AuthUser, @Body() dto: UnregisterDeviceDto) {
    return this.push.unregister(u.id, dto.token);
  }
}
