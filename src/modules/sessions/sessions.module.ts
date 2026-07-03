import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SessionsController, AdminSessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { Session, SessionSchema } from './schemas/session.schema';
import { TokenDenylist, TokenDenylistSchema } from './schemas/token-denylist.schema';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { SessionCleanupCron } from './session-cleanup.cron';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: TokenDenylist.name, schema: TokenDenylistSchema },
    ]),
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
    SubscriptionsModule,
    UsersModule,
    AuditModule,
  ],
  controllers: [SessionsController, AdminSessionsController],
  providers: [SessionsService, SessionCleanupCron],
  exports: [SessionsService],
})
export class SessionsModule {}
