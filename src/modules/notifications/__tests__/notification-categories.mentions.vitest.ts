import { describe, it, expect } from 'vitest';
import { NOTIFICATION_CATEGORIES, USER_TOGGLEABLE_CATEGORIES } from '../notification-categories';

// Guards the @mention (tag) alert category wiring. Links: FeedService.notifyMentioned
// + CommentService mention dispatch (emitters) + web notification-presentation.
describe('connect.post_mentioned category', () => {
  it('is a registered category', () => {
    expect(NOTIFICATION_CATEGORIES).toContain('connect.post_mentioned');
  });
  it('is user-toggleable (so the alert can be turned off)', () => {
    expect(USER_TOGGLEABLE_CATEGORIES).toContain('connect.post_mentioned');
  });
});
