import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../../../mail/mail.service';
import { ChannelDispatchInput, ChannelDispatchResult, maskEmail } from './types';

@Injectable()
export class EmailAdapter {
  private readonly logger = new Logger(EmailAdapter.name);
  constructor(private readonly mailService: MailService) {}

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchResult> {
    if (!input.recipientEmail) {
      return { success: false, status: 'skipped_no_contact', recipient: '***', errorMessage: 'no recipientEmail' };
    }
    const masked = maskEmail(input.recipientEmail);
    try {
      if (input.eventType === 'service_maintenance') {
        await this.mailService.sendServiceMaintenanceReminderEmail({
          to: input.recipientEmail,
          machineName: input.partyName,
          daysOverdue: input.daysPastDue ?? 0,
          lastMaintenanceDate: input.dueDate ?? '',
          workspaceName: input.workspaceName,
        });
      } else {
        await this.mailService.sendPaymentReminderEmail({
          to: input.recipientEmail,
          partyName: input.partyName,
          invoiceNumber: input.invoiceNumber ?? '',
          amountDue: input.invoiceAmountFormatted ?? '',
          daysPastDue: input.daysPastDue ?? 0,
          dueDate: input.dueDate ?? '',
          paymentLink: input.paymentLink,
          workspaceName: input.workspaceName,
          escalationLevel: input.escalationLevel ?? 1,
        });
      }
      return { success: true, status: 'sent', recipient: masked };
    } catch (err: any) {
      this.logger.error(`Email send failed to ${masked}: ${err?.message ?? err}`);
      return { success: false, status: 'failed', recipient: masked, errorMessage: (err?.message ?? 'unknown').slice(0, 500) };
    }
  }
}
