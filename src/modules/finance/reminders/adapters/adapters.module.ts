import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { MailModule } from '../../../mail/mail.module';
import {
  Subscription,
  SubscriptionSchema,
} from '../../../subscriptions/schemas/subscription.schema';
import { Workspace, WorkspaceSchema } from '../../../workspaces/schemas/workspace.schema';
import {
  WhatsappConversationWindow,
  WhatsappConversationWindowSchema,
} from './whatsapp-conversation-window.schema';
import { InAppAdapter } from './in-app.adapter';
import { EmailAdapter } from './email.adapter';
import { SmsAdapter } from './sms.adapter';
import { PushModule } from './push.module';
import { WhatsAppAdapter } from './whatsapp.adapter';

@Module({
  imports: [
    NotificationsModule,
    MailModule,
    // PushAdapter lives in its own module (re-exported below) so push-only
    // consumers can avoid importing AdaptersModule's NotificationsModule edge.
    PushModule,
    // Wave 4 credit-pack: WhatsAppAdapter deducts credits per send.
    MongooseModule.forFeature([
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      // Wave 8 — 24h conversation-window dedup for WhatsApp credit consume.
      {
        name: WhatsappConversationWindow.name,
        schema: WhatsappConversationWindowSchema,
      },
    ]),
  ],
  providers: [InAppAdapter, EmailAdapter, SmsAdapter, WhatsAppAdapter],
  // Re-export PushModule so existing consumers that import AdaptersModule and
  // inject PushAdapter (e.g. the reminder dispatcher) keep resolving it.
  exports: [InAppAdapter, EmailAdapter, SmsAdapter, WhatsAppAdapter, PushModule],
})
export class AdaptersModule {}
