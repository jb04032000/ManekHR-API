import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from '../../../notifications/notifications.service';
import { ChannelDispatchInput, ChannelDispatchResult } from './types';

@Injectable()
export class InAppAdapter {
  private readonly logger = new Logger(InAppAdapter.name);
  constructor(private readonly notificationsService: NotificationsService) {}

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchResult> {
    if (!input.recipientUserId) {
      return { success: false, status: 'skipped_no_contact', recipient: '***', errorMessage: 'no recipientUserId' };
    }
    try {
      const notif = await this.notificationsService.createNotification(
        String(input.workspaceId),
        {
          recipientId: String(input.recipientUserId),
          title: input.subject || `Payment reminder: ${input.partyName}`,
          message: input.body,
          type: input.escalationLevel === 3 ? 'error' : input.escalationLevel === 2 ? 'warning' : 'info',
          metadata: {
            entityType: 'reminder',
            entityId: input.invoiceId ? String(input.invoiceId) : input.machineId ? String(input.machineId) : null,
            firmId: String(input.firmId),
            partyId: String(input.partyId),
            ruleId: String(input.ruleId),
            eventType: input.eventType,
            escalationLevel: input.escalationLevel,
            link: input.invoiceId
              ? `/dashboard/finance/firms/${input.firmId}/invoices/${input.invoiceId}`
              : input.machineId
              ? `/dashboard/machines/${input.machineId}`
              : null,
          },
        },
      );
      return { success: true, status: 'sent', recipient: String(input.recipientUserId), messageId: String(notif._id) };
    } catch (err: any) {
      this.logger.error(`InApp send failed: ${err?.message ?? err}`);
      return { success: false, status: 'failed', recipient: String(input.recipientUserId), errorMessage: (err?.message ?? 'unknown').slice(0, 500) };
    }
  }
}
