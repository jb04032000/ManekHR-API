import { Types } from 'mongoose';

export type ReminderChannel = 'in_app' | 'email' | 'sms' | 'push' | 'whatsapp';

export interface ChannelDispatchInput {
  workspaceId: Types.ObjectId | string;
  firmId: Types.ObjectId | string;
  partyId: Types.ObjectId | string;
  ruleId: Types.ObjectId | string;
  invoiceId?: Types.ObjectId | string;
  machineId?: Types.ObjectId | string;
  // Recipient identity (one or more set depending on channel)
  recipientUserId?: Types.ObjectId | string;  // for in-app + push
  recipientEmail?: string;
  recipientPhone?: string;       // 10-digit India number, no country code
  recipientFcmToken?: string;
  // Message content
  subject?: string;
  body: string;
  // Template payload (used by SMS DLT + WhatsApp BSP)
  templateKey?: string;          // SMS DLT template id key OR WhatsApp campaign name
  templateParams?: string[];     // ordered VAR1..VARn for MSG91; templateParams[] for AiSensy
  // Context for in-app metadata + email rendering
  partyName: string;
  invoiceNumber?: string;
  invoiceAmountFormatted?: string;  // "₹45,000"
  daysPastDue?: number;
  dueDate?: string;
  paymentLink?: string;
  workspaceName: string;
  escalationLevel?: 1 | 2 | 3;
  eventType: 'invoice_overdue' | 'invoice_due_soon' | 'service_maintenance' | 'final_notice';
}

export interface ChannelDispatchResult {
  success: boolean;
  status: 'sent' | 'failed' | 'skipped_no_contact';
  recipient: string;            // MASKED — never the raw email/phone/token
  messageId?: string;           // provider message id when available
  errorMessage?: string;        // truncated, no PII
}

export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  const visible = local.length > 1 ? local[0] : '*';
  return `${visible}***@${domain}`;
}

export function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '***';
  const last4 = phone.slice(-4);
  return `+91*****${last4}`;
}

export function maskToken(token: string): string {
  if (!token || token.length < 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
