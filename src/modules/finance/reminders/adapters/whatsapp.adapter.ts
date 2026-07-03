import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import axios from 'axios';
import { ChannelDispatchInput, ChannelDispatchResult, maskPhone } from './types';
import { Subscription } from '../../../subscriptions/schemas/subscription.schema';
import { Workspace } from '../../../workspaces/schemas/workspace.schema';
import { WhatsappConversationWindow } from './whatsapp-conversation-window.schema';

const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WhatsAppAdapter {
  private readonly logger = new Logger(WhatsAppAdapter.name);
  private readonly endpoint = 'https://backend.aisensy.com/campaign/t1/api/v2';

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(Subscription.name)
    private readonly subscriptionModel: Model<Subscription>,
    @InjectModel(Workspace.name)
    private readonly workspaceModel: Model<Workspace>,
    @InjectModel(WhatsappConversationWindow.name)
    private readonly conversationWindowModel: Model<WhatsappConversationWindow>,
  ) {}

  /**
   * Wave 8 — atomic decrement of WhatsApp credit on the workspace owner's
   * subscription. Internal helper used only by `consumeForConversation`
   * after the 24h-window check has confirmed a fresh conversation needs
   * to be opened (i.e. customer is being charged).
   */
  private async tryConsumeWhatsappCredit(
    workspaceId: Types.ObjectId | string,
  ): Promise<boolean> {
    const wsObjId =
      workspaceId instanceof Types.ObjectId
        ? workspaceId
        : new Types.ObjectId(String(workspaceId));
    const ws = await this.workspaceModel
      .findById(wsObjId, { ownerId: 1 })
      .lean();
    if (!ws?.ownerId) return false;
    const ownerId =
      ws.ownerId instanceof Types.ObjectId
        ? ws.ownerId
        : new Types.ObjectId(String(ws.ownerId));
    const result = await this.subscriptionModel.findOneAndUpdate(
      {
        userId: ownerId,
        status: { $in: ['active', 'trial'] },
        'appliedEntitlements.communications.whatsappCreditsBalance': { $gte: 1 },
      },
      {
        $inc: {
          'appliedEntitlements.communications.whatsappCreditsBalance': -1,
        },
      },
      { new: true, projection: { _id: 1 } },
    );
    return result !== null;
  }

  /**
   * Wave 8 — Meta-aligned billing. 1 conversation = 24h window of unlimited
   * messages to the same peer. Returns:
   *   { ok: true, opened: true,  windowId } → fresh conversation, credit charged
   *   { ok: true, opened: false, windowId } → reused open window, NO credit
   *   { ok: false }                          → insufficient balance for new window
   *
   * Race-safe: two parallel sends to same peer at window boundary may both
   * try to open. Mongo unique-ish index on (workspaceId, peerPhone, expiresAt)
   * is best-effort; rare double-charge under contention is acceptable for now.
   */
  private async consumeForConversation(
    workspaceId: Types.ObjectId,
    peerPhone: string,
    category: 'utility' | 'authentication' | 'marketing' | 'service' = 'utility',
  ): Promise<{ ok: boolean; opened: boolean; windowId?: string }> {
    const now = new Date();
    const open = await this.conversationWindowModel
      .findOne({
        workspaceId,
        peerPhone,
        category,
        expiresAt: { $gt: now },
      })
      .sort({ expiresAt: -1 })
      .lean();

    if (open) {
      return { ok: true, opened: false, windowId: String(open._id) };
    }

    const consumed = await this.tryConsumeWhatsappCredit(workspaceId);
    if (!consumed) {
      return { ok: false, opened: true };
    }

    const window = await this.conversationWindowModel.create({
      workspaceId,
      peerPhone,
      category,
      openedAt: now,
      expiresAt: new Date(now.getTime() + CONVERSATION_WINDOW_MS),
    });
    return { ok: true, opened: true, windowId: String(window._id) };
  }

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchResult> {
    if (!input.recipientPhone) {
      return { success: false, status: 'skipped_no_contact', recipient: '***', errorMessage: 'no recipientPhone' };
    }
    const masked = maskPhone(input.recipientPhone);
    const apiKey = this.configService.get<string>('app.aisensy.apiKey');
    const fallbackCampaign = this.configService.get<string>('app.aisensy.paymentReminderCampaign');
    const campaignName = input.templateKey || fallbackCampaign;

    if (!apiKey || !campaignName) {
      return { success: false, status: 'failed', recipient: masked, errorMessage: 'aisensy config missing (apiKey/campaignName)' };
    }

    const raw = input.recipientPhone.replace(/\D/g, '').slice(-10);
    const destination = input.recipientPhone.startsWith('+') ? input.recipientPhone : `+91${raw}`;

    // Wave 8 — 24h conversation-window-aware credit consume. First message
    // to a peer in 24h opens a window + consumes 1 credit. Subsequent
    // messages within the window are free (matches Meta utility-template
    // pricing). Insufficient balance for a fresh window → abort.
    const wsObjId =
      input.workspaceId instanceof Types.ObjectId
        ? input.workspaceId
        : new Types.ObjectId(String(input.workspaceId));
    const peerKey = destination.replace(/\D/g, '');
    const conversation = await this.consumeForConversation(wsObjId, peerKey);
    if (!conversation.ok) {
      return {
        success: false,
        status: 'failed',
        recipient: masked,
        errorMessage:
          'Insufficient WhatsApp credits — purchase a WhatsApp pack to send',
      };
    }

    try {
      const res = await axios.post(this.endpoint, {
        apiKey,
        campaignName,
        destination,
        userName: input.partyName,
        source: 'zari360-reminder-engine',
        templateParams: input.templateParams ?? [],
        tags: ['reminder', input.eventType],
        attributes: { firmId: String(input.firmId), partyId: String(input.partyId) },
      }, { timeout: 15_000 });
      const messageId = res?.data?.submitted_message_id ?? res?.data?.messageId ?? undefined;
      return { success: true, status: 'sent', recipient: masked, messageId };
    } catch (err: any) {
      const errMsg = err?.response?.data?.message ?? err?.response?.data ?? err?.message ?? 'aisensy unknown';
      this.logger.error(`WhatsApp send failed to ${masked}: ${typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)}`);
      return { success: false, status: 'failed', recipient: masked, errorMessage: String(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)).slice(0, 500) };
    }
  }
}
