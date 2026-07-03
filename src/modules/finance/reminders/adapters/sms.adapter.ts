import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsService } from '../../../sms/sms.service';
import { ChannelDispatchInput, ChannelDispatchResult, maskPhone } from './types';

/**
 * Reminders SMS adapter — delegates to centralised SmsService.
 *
 * Wave-3 Drift #35 — switched from direct axios call to SmsService.sendDltSms
 * so all SMS dispatches share:
 *   - SmsDispatchLog audit trail
 *   - credit accounting (for future credit-pack model)
 *   - mobile normalisation (handles +91 prefix, hyphens, spaces)
 *   - workspace + firm scoping
 *
 * The previous direct-axios implementation worked but bypassed all of that.
 */
@Injectable()
export class SmsAdapter {
  private readonly logger = new Logger(SmsAdapter.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly smsService: SmsService,
  ) {}

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchResult> {
    if (!input.recipientPhone) {
      return {
        success: false,
        status: 'skipped_no_contact',
        recipient: '***',
        errorMessage: 'no recipientPhone',
      };
    }

    const masked = maskPhone(input.recipientPhone);
    const templateId =
      input.templateKey ||
      this.configService.get<string>('app.msg91.paymentReminderTemplateId');

    if (!templateId) {
      return {
        success: false,
        status: 'failed',
        recipient: masked,
        errorMessage: 'msg91 templateId missing — check MSG91_PAYMENT_REMINDER_TEMPLATE_ID env',
      };
    }

    // Build VAR1..VARn map from templateParams
    const vars: Record<string, string> = {};
    (input.templateParams ?? []).forEach((v, i) => {
      vars[`VAR${i + 1}`] = v;
    });

    const result = await this.smsService.sendDltSms({
      workspaceId: input.workspaceId,
      firmId: input.firmId,
      mobile: input.recipientPhone,
      templateId,
      vars,
      entityRef: input.invoiceId
        ? { id: input.invoiceId, type: 'SaleInvoice' }
        : input.machineId
          ? { id: input.machineId, type: 'Machine' }
          : undefined,
    });

    if (result.status === 'sent') {
      return {
        success: true,
        status: 'sent',
        recipient: masked,
        messageId: result.providerMessageId,
      };
    }

    if (result.status === 'skipped') {
      // Map SmsService 'skipped' to ChannelDispatchResult — closest match is 'failed'
      // since 'skipped_no_contact' implies missing recipient (already handled above).
      return {
        success: false,
        status: 'failed',
        recipient: masked,
        errorMessage: result.errorMessage,
      };
    }

    // status === 'failed'
    return {
      success: false,
      status: 'failed',
      recipient: masked,
      errorMessage: result.errorMessage,
    };
  }
}
