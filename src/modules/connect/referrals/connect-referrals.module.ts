import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../../audit/audit.module';
import { AdsModule } from '../ads/ads.module';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { ConnectProfile, ConnectProfileSchema } from '../profile/schemas/connect-profile.schema';
import {
  ConnectReferralConfig,
  ConnectReferralConfigSchema,
} from './schemas/connect-referral-config.schema';
import { ConnectReferral, ConnectReferralSchema } from './schemas/connect-referral.schema';
import { ConnectReferralConfigService } from './services/connect-referral-config.service';
import { ReferralService } from './services/referral.service';
import { ReferralController } from './controllers/referral.controller';
import { ReferralAdminController } from './controllers/referral-admin.controller';

/**
 * ManekHR Connect -- Referrals module (Connect Referral Program).
 *
 * What this does: hosts the whole referral feature -- the singleton admin
 * config (levers), the per-referee tracking rows, the attribution / qualify /
 * release / summary / admin-log / clawback service, and the two controllers
 * (`connect/referrals/me` for the user, `admin/connect/referrals/*` for admin).
 *
 * DI layout:
 *  - MongooseModule.forFeature registers the two referral schemas, `User`, AND
 *    `ConnectProfile` (both schema-only tokens) so ReferralService can read
 *    names/handles, lazily stamp referralCode / referredByUserId, and check
 *    whether a referee already has a Connect profile (the qualify ordering
 *    safety-net). Re-registering a foreign schema here is safe -- @nestjs/mongoose
 *    reuses the existing connection model rather than redefining it (same pattern
 *    institutes/ads use for shared models). Importing the ConnectProfile *schema*
 *    is NOT importing ConnectProfileModule, so no module cycle is introduced.
 *  - AdsModule is imported for `WalletService` (creditReferral on release,
 *    adjust on clawback). AdsModule EXPORTS WalletService (the wallet is a single
 *    shared instance with the one set of wallet/ledger model bindings), so no
 *    model is re-registered and no ads internals leak in.
 *  - AuditModule is imported for AuditService (the audited config update +
 *    referral_clawback admin writes, under AppModule.ADS).
 *  - ScheduleModule.forRoot() is NOT registered here. ReferralService's
 *    @Cron(releaseHeldReferrals) is activated by the single global forRoot() in
 *    SalaryModule -- the schedule explorer scans EVERY provider in the app, so a
 *    registered ReferralService provider is enough. Calling forRoot() again would
 *    duplicate every cron (not idempotent in @nestjs/schedule v6).
 *  - The qualify path listens to CONNECT_PROFILE_CREATED purely via the global
 *    EventEmitter (imported by name + type only), so this module needs no import
 *    of the profile module -- no cycle.
 *
 * Cycle safety: this module imports AdsModule + AuditModule + the User &
 *  ConnectProfile *schemas* only (never their owning modules). Neither AdsModule
 *  (-> ConnectProfileModule + AuditModule) nor AuditModule imports AuthModule, so
 *  AuthModule can safely import THIS module to inject ReferralService into
 *  AuthService (the signup attribution call) without a cycle. This module must
 *  NEVER import AuthModule or ConnectProfileModule.
 *
 * Exports: ReferralService + ConnectReferralConfigService so AuthModule can inject
 *  ReferralService (attachReferralAtSignup) into AuthService + SmsOtpService.
 *
 * Registered in the parent app wiring (app.module.ts) only -- mirrors how
 * ConnectInstitutesModule is registered (a leaf-style feature module).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ConnectReferralConfig.name, schema: ConnectReferralConfigSchema },
      { name: ConnectReferral.name, schema: ConnectReferralSchema },
      // User: schema-only token. ReferralService reads name/handle/mobile/email
      // and lazily stamps referralCode + referredByUserId. Owned by UsersModule;
      // re-registering the model here is safe (shared connection model).
      { name: User.name, schema: UserSchema },
      // ConnectProfile: schema-only token (owned by ConnectProfileModule). READ-ONLY
      // here -- ReferralService only checks whether a referee already has a profile
      // at signup-attach time (the event/attach ordering safety-net). Re-registering
      // the model is safe (shared connection model, same pattern as User) and does
      // NOT import ConnectProfileModule, so no module cycle is introduced.
      { name: ConnectProfile.name, schema: ConnectProfileSchema },
    ]),
    // WalletService (creditReferral on release; adjust on clawback). Exported by AdsModule.
    AdsModule,
    // AuditService for the audited config update + clawback admin writes.
    AuditModule,
  ],
  controllers: [ReferralController, ReferralAdminController],
  providers: [ReferralService, ConnectReferralConfigService],
  // Exported so AuthModule can inject ReferralService into AuthService + SmsOtpService
  // for the best-effort attachReferralAtSignup call. (Config service exported too for
  // symmetry / future server-side reads.)
  exports: [ReferralService, ConnectReferralConfigService],
})
export class ConnectReferralsModule {}
