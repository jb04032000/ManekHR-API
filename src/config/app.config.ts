import { registerAs } from '@nestjs/config';
import { env } from './env';

export default registerAs('app', () => ({
  port: env.port,
  environment: env.nodeEnv,
  frontendUrl: env.webAppUrl,
  inviteTokenExpiryDays: env.inviteTokenExpiryDays,
  adminSetupSecret: env.adminSetupSecret,
  firebase: {
    projectId: env.firebase.projectId,
    clientEmail: env.firebase.clientEmail,
    privateKey: env.firebase.privateKey,
  },
  msg91: {
    authKey: env.msg91.authKey,
    senderId: env.msg91.senderId,
    paymentReminderTemplateId: env.msg91.paymentReminderTemplateId,
  },
  aisensy: {
    apiKey: env.aisensy.apiKey,
    paymentReminderCampaign: env.aisensy.paymentReminderCampaign,
  },
  /**
   * Platform-level Razorpay credentials for SaaS subscription billing.
   * Distinct from per-firm Razorpay credentials used by party-portal payment
   * links. Required for D1b onward — order create + signature verify + webhook.
   */
  razorpayPlatform: {
    keyId: env.razorpay.keyId,
    keySecret: env.razorpay.keySecret,
    webhookSecret: env.razorpay.webhookSecret,
  },
  /**
   * Legal entity that issues GST invoices for SaaS subscription payments.
   * Single tenant — ManekHR's own legal info. All values flow into the
   * generated PDF + the invoice numbering sequence.
   */
  platformLegalEntity: {
    name: env.platformLegal.name,
    gstin: env.platformLegal.gstin,
    pan: env.platformLegal.pan,
    addressLine1: env.platformLegal.addressLine1,
    addressLine2: env.platformLegal.addressLine2,
    city: env.platformLegal.city,
    state: env.platformLegal.state,
    stateCode: env.platformLegal.stateCode,
    pincode: env.platformLegal.pincode,
    email: env.platformLegal.email,
    phone: env.platformLegal.phone,
    invoiceNumberPrefix: env.platformLegal.invoiceNumberPrefix,
  },
}));
