import { IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * DTOs for the `connect/network` controller. Connection requests, responses,
 * and the Invitations box filter (`docs/connect/phases/phase-2-network.md`).
 */

/** POST `/me/connect/network/requests` — send a connection request. */
export class SendConnectionRequestDto {
  /** The `User` to send the request to. */
  @IsMongoId()
  toUserId: string;

  /** Optional short message attached to the request. */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}

/** The two responses a recipient can give to a pending request. */
export const CONNECTION_REQUEST_ACTIONS = ['accept', 'ignore'] as const;
export type ConnectionRequestAction = (typeof CONNECTION_REQUEST_ACTIONS)[number];

/** PATCH `/me/connect/network/requests/:id` — accept or ignore a request. */
export class RespondConnectionRequestDto {
  @IsIn(CONNECTION_REQUEST_ACTIONS)
  action: ConnectionRequestAction;
}

/** The three Invitations boxes. */
export const INVITATION_BOXES = ['received', 'sent', 'archive'] as const;
export type InvitationBox = (typeof INVITATION_BOXES)[number];

/** Query for GET `/me/connect/network/invitations` — defaults to `received`. */
export class ListInvitationsQueryDto {
  @IsOptional()
  @IsIn(INVITATION_BOXES)
  box?: InvitationBox;
}
