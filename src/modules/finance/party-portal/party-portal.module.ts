import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { PortalAccessToken, PortalAccessTokenSchema } from './portal-access-token.schema';
import { Firm, FirmSchema } from '../firms/firm.schema';
import { Party, PartySchema } from '../parties/party.schema';
import { LedgerEntry, LedgerEntrySchema } from '../sales/ledger-posting/ledger-entry.schema';
import { SaleInvoice, SaleInvoiceSchema } from '../sales/sale-invoice/sale-invoice.schema';
import {
  PaymentReceipt,
  PaymentReceiptSchema,
} from '../payments/payment-receipt/payment-receipt.schema';
import { PortalTokenService } from './portal-token.service';
import { PortalTokenGuard } from './portal-token.guard';
import { PortalThrottlerGuard } from './portal-throttler.guard';
import { PortalPdfNonceService } from './portal-pdf-nonce.service';
import { PortalPublicService } from './portal-public.service';
import { PortalPublicController } from './portal-public.controller';
import { PortalTokenController } from './portal-token.controller';
import { AuditModule } from '../../audit/audit.module';
import { MailModule } from '../../mail/mail.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { RbacModule } from '../../rbac/rbac.module';
import { PartiesModule } from '../parties/parties.module';
import { FirmsModule } from '../firms/firms.module';
import { SaleInvoiceModule } from '../sales/sale-invoice/sale-invoice.module';
import { ReportsModule } from '../reports/reports.module';
import { PaymentReceiptModule } from '../payments/payment-receipt/payment-receipt.module';

/**
 * PartyPortalModule (Phase 16 Plan 04 — FIN-15-03).
 *
 * Provides:
 *   - PortalTokenService — issue/verify/revoke
 *   - PortalTokenGuard   — reads X-Portal-Token header, attaches req.portalContext
 *   - PortalThrottlerGuard — 60 req/min per (jti, ip)
 *   - PortalPdfNonceService — one-time HMAC-signed PDF sub-URL
 *   - PortalPublicService — /portal/context outstanding aggregation
 *   - PortalPublicController — /portal/{context,statement,invoices,...}
 *   - PortalTokenController — /finance/parties/:partyId/portal-tokens
 *
 * Registers a SECOND JwtService (separate from auth's) using
 * PORTAL_TOKEN_SECRET and audience='party-portal'. NestJS resolves
 * JwtService per-importing-module so this coexists with AuthModule's
 * JwtService.
 *
 * Registers a named ThrottlerModule definition 'portal' with 60 req per 60s.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PortalAccessToken.name, schema: PortalAccessTokenSchema },
      { name: Firm.name, schema: FirmSchema },
      { name: Party.name, schema: PartySchema },
      { name: LedgerEntry.name, schema: LedgerEntrySchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: PaymentReceipt.name, schema: PaymentReceiptSchema },
    ]),
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('PORTAL_TOKEN_SECRET'),
        signOptions: {
          audience: 'party-portal',
          expiresIn: '30d',
        },
        verifyOptions: { audience: 'party-portal' },
      }),
      inject: [ConfigService],
    }),
    ThrottlerModule.forRoot([{ name: 'portal', limit: 60, ttl: 60_000 }]),
    AuditModule,
    MailModule,
    SubscriptionsModule,
    RbacModule,
    forwardRef(() => PartiesModule),
    forwardRef(() => FirmsModule),
    forwardRef(() => SaleInvoiceModule),
    forwardRef(() => ReportsModule),
    forwardRef(() => PaymentReceiptModule),
  ],
  controllers: [PortalPublicController, PortalTokenController],
  providers: [
    PortalTokenService,
    PortalTokenGuard,
    PortalThrottlerGuard,
    PortalPdfNonceService,
    PortalPublicService,
  ],
  exports: [PortalTokenService, MongooseModule],
})
export class PartyPortalModule {}
