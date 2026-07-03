import { IsMongoId } from 'class-validator';

/**
 * Path-param validation for the Institutes Phase 2 (Feature 2) institute-admin
 * credential confirm/decline + pending-list routes.
 *
 * What this does: validates the route ids before they reach the service.
 * `pageId` (the institute CompanyPage), `studentUserId` (the credential owner),
 * and `trainingId` (the stable per-credential handle). Every one is a Mongo
 * ObjectId hex string: the CompanyPage `_id`, the `User` `_id`, and the training
 * subdoc's server-assigned `id` (an ObjectId hex string, see
 * ConnectTrainingItem.id), so `@IsMongoId()` is the correct validator for all
 * three.
 *
 * Cross-module links: `pageId` -> Connect entities CompanyPage (the page-admin
 * gate is `CompanyPageService.getMine`); `studentUserId` -> `User`;
 * `trainingId` -> ConnectProfile.training[].id. Keep in sync with
 * ConnectProfileService.decideCredential / listPendingCredentialRequests.
 */
export class CredentialRequestsParams {
  /** The institute CompanyPage whose pending-credential queue is being read. */
  @IsMongoId()
  pageId: string;
}

export class DecideCredentialParams {
  @IsMongoId()
  pageId: string;

  @IsMongoId()
  studentUserId: string;

  /** The training subdoc's stable id (an ObjectId hex string). */
  @IsMongoId()
  trainingId: string;
}
