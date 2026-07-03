import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SmsOtpService } from './services/sms-otp.service';
import { AccountErasureService } from './services/account-erasure.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../mail/mail.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AuditModule } from '../audit/audit.module';
// Connect Referral Program: provides ReferralService for the best-effort signup
// attribution call (attachReferralAtSignup) in AuthService + SmsOtpService. The
// referrals module imports AdsModule + AuditModule + User-schema only -- nothing
// in that chain imports AuthModule, so this is a one-way dependency (no cycle).

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: {
          expiresIn: configService.get<string>('jwt.accessExpiry') as JwtSignOptions['expiresIn'],
        },
      }),
      inject: [ConfigService],
    }),
    MailModule,
    SubscriptionsModule,
    SessionsModule,
    AuditModule,
    // ReferralService for the best-effort signup attribution (no cycle: see import note).
  ],
  // AccountErasureService (OQ-3) is the admin-triggered DPDP erasure
  // coordinator. Exported so AdminModule can expose the admin-only endpoint
  // without re-implementing the scrub. UsersModule (already imported) provides
  // the User model + UserClaimsCacheService it needs.
  providers: [AuthService, SmsOtpService, JwtStrategy, JwtRefreshStrategy, AccountErasureService],
  controllers: [AuthController],
  exports: [AuthService, SmsOtpService, AccountErasureService],
})
export class AuthModule {}
