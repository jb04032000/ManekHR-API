import { IsIn } from 'class-validator';

/**
 * UI hints a user can permanently dismiss. Persisted on `User.dismissedHints`
 * so a dismissal survives sign-out and follows the user across devices
 * (localStorage did neither — it is wiped by `localStorage.clear()` on
 * sign-out). The web `DismissibleHint` type mirrors this list.
 */
export const DISMISSIBLE_HINTS = [
  'connect_explore',
  'connect_profile_card',
  'connect_erp_crosssell',
] as const;
export type DismissibleHint = (typeof DISMISSIBLE_HINTS)[number];

/** POST body for `/me/dismiss-hint`. */
export class DismissHintDto {
  @IsIn(DISMISSIBLE_HINTS)
  hint: DismissibleHint;
}
