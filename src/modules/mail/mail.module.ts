import { Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
// import { MailService } from './mail.service';
import { join } from 'path';
import { MailService } from './mail.service';
import { Workspace, WorkspaceSchema } from '../workspaces/schemas/workspace.schema';

/**
 * Because @nestjs-modules/mailer is sometimes weird with esModuleInterop,
 * ensure you use the exact path above when importing HandlebarsAdapter.
 */

@Module({
  imports: [
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        transport: {
          host: config.get('SMTP_HOST'),
          port: config.get('SMTP_PORT'),
          secure: config.get('SMTP_PORT') == 465, // true for 465, false for other ports
          auth: {
            user: config.get('SMTP_USER'),
            pass: config.get('SMTP_PASS'),
          },
        },
        defaults: {
          from: `"ManekHR Support" <${config.get('SMTP_FROM')}>`,
        },
        template: {
          // Resolve relative to the compiled file (dist/modules/mail) — copy:assets
          // places the .hbs templates alongside it. Using process.cwd()+'src' broke
          // in the production image (no src/ dir). Mirrors mail.service.ts.
          dir: join(__dirname, 'templates'),
          adapter: new HandlebarsAdapter(),
          options: {
            strict: true,
          },
        },
      }),
      inject: [ConfigService],
    }),
    // Wave-3 Drift #32 — universal email-quota enforcement needs Workspace model
    // for usage tracking. Subscription model accessed via SubscriptionsModule (@Global).
    MongooseModule.forFeature([{ name: Workspace.name, schema: WorkspaceSchema }]),
  ],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
