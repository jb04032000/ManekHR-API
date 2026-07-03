import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectProfile, ConnectProfileSchema } from './schemas/connect-profile.schema';
import { ErpLinkService } from './erp-link.service';
import { ErpVerificationService } from './erp-verification.service';
import { ConnectProfileService } from './connect-profile.service';
import {
  ConnectProfileController,
  ConnectProfilePublicController,
  ConnectFeaturedController,
} from './connect-profile.controller';
import { AuditModule } from '../../audit/audit.module';
import { MediaOwnershipModule } from '../../uploads/media-ownership.module';
import { ConnectAllowanceModule } from '../monetization/connect-allowance.module';
import { ConnectReviewsModule } from '../reviews/connect-reviews.module';
import { User, UserSchema } from '../../users/schemas/user.schema';
import { Connection, ConnectionSchema } from '../network/schemas/connection.schema';
import { CompanyPage, CompanyPageSchema } from '../entities/schemas/company-page.schema';
import { Storefront, StorefrontSchema } from '../entities/schemas/storefront.schema';
import { Workspace, WorkspaceSchema } from '../../workspaces/schemas/workspace.schema';
import {
  WorkspaceMember,
  WorkspaceMemberSchema,
} from '../../workspaces/schemas/workspace-member.schema';
import { Attendance, AttendanceSchema } from '../../attendance/schemas/attendance.schema';
import { Salary, SalarySchema } from '../../salary/schemas/salary.schema';
import {
  SaleInvoice,
  SaleInvoiceSchema,
} from '../../finance/sales/sale-invoice/sale-invoice.schema';
import {
  ExpenseVoucher,
  ExpenseVoucherSchema,
} from '../../finance/expenses/expense-voucher.schema';

/**
 * ManekHR Connect — Profile module (Phase 0 scaffold).
 *
 * Phase 0 ships the `ConnectProfile` schema, the `ErpLinkService` ERP-linked
 * moat derivation, and the module wiring only. Profile CRUD endpoints +
 * controller are Phase 1 — deliberately not built here.
 *
 * Schema registration strategy:
 *   - `ConnectProfile` — this module owns it.
 *   - `User`, `Workspace`, `WorkspaceMember` — registered for read access.
 *     `User` backs the `ConnectProfile.userId` ref (viewer-facing identity).
 *     `WorkspaceMember` is load-bearing: `ErpLinkService.getUserStatus`
 *     resolves a user's active employment from it to derive the ERP-linked
 *     moat signal (Connect is standalone — a `ConnectProfile` carries no
 *     workspace ref, so ERP context comes from employment, not the profile).
 *     `Workspace` is registered for read access by Connect sub-modules /
 *     later phases (it is re-exported via `MongooseModule` below); it backs
 *     workspace lookups such as resolving an employer's display name from a
 *     `WorkspaceMember.workspaceId`. The owning modules (`UsersModule` /
 *     `WorkspacesModule`) also register these names; Mongoose keys models by
 *     name on the shared connection, so a local `forFeature` is the standard
 *     NestJS pattern for cross-module read access — no coupling to those
 *     modules' internals.
 *   - `Attendance`, `Salary`, `SaleInvoice`, `ExpenseVoucher` — the four ERP
 *     activity collections `ErpLinkService` reads to derive the moat signal.
 *     Registered directly here (rather than importing the heavy
 *     `AttendanceModule` / `SalaryModule` / `FinanceModule` graphs — and
 *     `SaleInvoiceModule` does not even re-export its model). Read-only.
 *
 * Exports `ErpLinkService` + `MongooseModule` so Phase 1's profile service /
 * controller and other Connect sub-modules can consume the derivation and the
 * `ConnectProfile` model.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ConnectProfile.name, schema: ConnectProfileSchema },
      // Identity refs — read access.
      { name: User.name, schema: UserSchema },
      // Connect network connection graph — read-only, registered here (rather
      // than importing ConnectNetworkModule, which would create a cycle since
      // it imports ConnectProfileModule). Backs the per-intent `network`
      // audience gate in ConnectProfileService.trimByAudience.
      { name: Connection.name, schema: ConnectionSchema },
      // Connect entities CompanyPage - read-only, registered here (rather than
      // importing ConnectEntitiesModule, which would create a cycle: entities
      // already imports ConnectProfileModule for ErpLinkService). Backs the
      // experience->linked-company ref resolution in
      // ConnectProfileService.companyRefs. The schema file is a leaf (mongoose +
      // User only), so importing it pulls in no service graph.
      { name: CompanyPage.name, schema: CompanyPageSchema },
      // Storefront - read/write for the account-erasure cascade (ADR-0004):
      // `handleAccountErased` clears the erased user's ERP links on every owned
      // CompanyPage / Storefront. Registered read-access here (the entities
      // module owns it; the schema file is a leaf, so no service-graph pull-in).
      { name: Storefront.name, schema: StorefrontSchema },
      { name: Workspace.name, schema: WorkspaceSchema },
      { name: WorkspaceMember.name, schema: WorkspaceMemberSchema },
      // ERP activity collections — read-only, for ErpLinkService.
      { name: Attendance.name, schema: AttendanceSchema },
      { name: Salary.name, schema: SalarySchema },
      { name: SaleInvoice.name, schema: SaleInvoiceSchema },
      { name: ExpenseVoucher.name, schema: ExpenseVoucherSchema },
    ]),
    AuditModule,
    // ConnectAllowanceService for the seller verified marker on public profiles
    // (M2.3). Imported via the allowance-only module to avoid the AdsModule cycle.
    ConnectAllowanceModule,
    // Seller rating aggregate on the public profile (marketplace Phase C, R2).
    ConnectReviewsModule,
    // Shared media-URL ownership guard — enforces that banner / portfolio image
    // URLs submitted on profile update were uploaded by the caller (IDOR guard).
    MediaOwnershipModule,
  ],
  controllers: [
    ConnectProfileController,
    ConnectProfilePublicController,
    ConnectFeaturedController,
  ],
  providers: [ErpLinkService, ErpVerificationService, ConnectProfileService],
  exports: [ErpLinkService, ErpVerificationService, ConnectProfileService, MongooseModule],
})
export class ConnectProfileModule {}
