import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { isPrivateRef } from '../private-media.ref';

/**
 * DTO-level guard for a media URL field that may now carry EITHER a public
 * https URL (public categories: feed, products, profiles, ERP docs) OR a private
 * canonical `r2-private://<key>` ref (chat attachments, job-application files).
 *
 * Replaces the prior `@IsUrl({ protocols: ['https'] })` on those fields, which
 * rejected the private scheme. This is a cheap shape gate only - the real
 * authority is `MediaOwnershipService.assertOwnedMedia`, which proves the value
 * is a real file on our storage owned by the caller. Cross-module: used by the
 * inbox SendMessage DTO + the jobs CreateJobApplication DTO.
 */
@ValidatorConstraint({ name: 'isMediaRef', async: false })
export class IsMediaRefConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (isPrivateRef(value)) return true;
    try {
      const u = new URL(value);
      return u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'must be an https URL or a private media reference';
  }
}

/** Accepts an https URL or a private `r2-private://` media ref. */
export function IsMediaRef(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsMediaRefConstraint,
    });
  };
}
