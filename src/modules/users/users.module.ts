import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { UsersService } from './users.service';
import { UserClaimsCacheService } from './user-claims-cache.service';
import { UsersController } from './users.controller';
import { MePolicyController } from './me-policy.controller';
import { MePrefsController } from './me-prefs.controller';
import { MeProfileController } from './me-profile.controller';
import { MeSecurityController } from './me-security.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    // `MeProfileController.claimHandle` logs via `AuditService`. `PostHogService`
    // is `@Global()` so it does not need a module import here.
    AuditModule,
  ],
  controllers: [
    UsersController,
    MePolicyController,
    MePrefsController,
    MeProfileController,
    MeSecurityController,
  ],
  // UserClaimsCacheService backs the JWT hot-path cache (OQ-2). Exported so the
  // JwtStrategy reads it and AuthService / AdminService invalidate it on writes
  // that change isAdmin / isActive / email / mobile. Redis is @Global so no
  // RedisModule import is needed here.
  providers: [UsersService, UserClaimsCacheService],
  exports: [UsersService, UserClaimsCacheService, MongooseModule],
})
export class UsersModule {}
