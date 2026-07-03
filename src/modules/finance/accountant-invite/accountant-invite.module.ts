import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountantInvite, AccountantInviteSchema } from './accountant-invite.schema';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { AccountantInvitesService } from './accountant-invites.service';
import { AccountantInvitesController, AccountantAcceptController } from './accountant-invites.controller';
import { MailModule } from '../../mail/mail.module';
import { WorkspacesModule } from '../../workspaces/workspaces.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountantInvite.name, schema: AccountantInviteSchema },
      { name: User.name, schema: UserSchema },
    ]),
    MailModule,
    WorkspacesModule,
    SubscriptionsModule,
  ],
  controllers: [AccountantInvitesController, AccountantAcceptController],
  providers: [AccountantInvitesService],
  exports: [AccountantInvitesService],
})
export class AccountantInviteModule {}
