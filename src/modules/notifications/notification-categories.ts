/**
 * Notification categories — typed enum + display metadata.
 *
 * Every event the platform dispatches goes through one of these category
 * keys. The key acts as the join on:
 *   - `NotificationPreferences.prefs[<category>]` — per-channel opt-in
 *   - the FE category filter chips on `/connect/notifications`
 *   - the FE category → route map (`notificationHref(category)`)
 *
 * Convention: `<module>.<verb>_<noun>` snake_case under the module — e.g.
 * `connect.connection_requested`. New events: add the enum entry here +
 * a default `inPlatform: true` to `defaultPreferencesFor()` below, and
 * the rest of the pipeline (dispatcher + UI) picks it up.
 *
 * Legacy categories — Invite notifications historically used
 * `metadata.category = 'INVITE_RECEIVED' | 'INVITE_ACCEPTED'` (uppercase
 * snake). Listed here so the new pipeline + UI route them identically.
 * Existing rows are untouched.
 */

export const NOTIFICATION_CATEGORIES = [
  // Connect — network
  'connect.connection_requested',
  'connect.connection_accepted',
  'connect.followed',
  // Connect — feed
  'connect.post_reacted',
  'connect.post_commented',
  'connect.post_reposted',
  'connect.post_replied',
  // Connect - feed: fired when a user is @mentioned (tagged) in a post or
  // comment. Recipient = the tagged user (or a tagged page/storefront owner);
  // actor = the tagger. User-toggleable + batchable. Keep in sync with
  // FeedService.notifyMentioned + CommentService mention dispatch + the web
  // notification-presentation route map.
  'connect.post_mentioned',
  // Connect — marketplace
  'connect.inquiry_received',
  // Connect ads (publish-then-moderate): fired when an admin takes a live boost
  // down. The campaign owner (advertiser) is the recipient; system/operator
  // event (no actor surfaced), so NOT user-toggleable -- the advertiser must
  // always learn their boost stopped serving + why. Keep in sync with
  // AdsAdminService.reject (the only emitter) + the web notification route map.
  'connect.boost_taken_down',
  // Connect — company pages
  'connect.page_followed',
  // Connect institutes (Institutes Phase 2, Feature 2): the institute page owner
  // confirmed / declined a student's self-declared training credential. The
  // student is the recipient; the institute member is the actor. User-toggleable
  // (a personal social event, like a job-application decision). Keep in sync with
  // ConnectProfileService.decideCredential (the only emitter) + the web confirm
  // badge / notifications route map.
  'connect.credential_confirmed',
  'connect.credential_declined',
  // Connect institutes (Institutes Phase 2, Feature 4): a business sent a "hire
  // our trained candidates" lead to an institute. The institute page owner is the
  // recipient; the business member is the actor. User-toggleable (a personal
  // inbound-lead event, like an inquiry). Keep in sync with
  // CandidateRequestService.create (the only emitter) + metadata.threadId deep-link
  // + the web inbox candidate-request card / notifications route map.
  'connect.hire_lead_received',
  // Connect introductions (broker introductions slice): a broker introduces a
  // buyer + a seller; both introduced parties must confirm. `introduction_created`
  // -> the two introduced parties (actor = broker); `introduction_confirmed` ->
  // the broker + the other party once both sides confirm (actor = the confirming
  // party); `introduction_declined` is not dispatched (no bell on decline).
  // User-toggleable (personal social events). Keep in sync with
  // IntroductionService (the only emitter) + the web notification route map.
  'connect.introduction_created',
  'connect.introduction_confirmed',
  'connect.introduction_declined',
  // Connect — jobs (hiring funnel; these DO notify, unlike the RFQ board)
  'connect.job_application_received',
  'connect.job_application_accepted',
  'connect.job_application_declined',
  // Connect -- inbox (1:1 messaging; never batched -- each message is distinct)
  'connect.message_received',
  // Connect -- monetization: fired once per (user, kind, episode) when a person
  // goes OVER a count limit (grandfathering notice). Operational/system event
  // (no actor), so not user-toggleable.
  'connect.over_limit',
  // Connect -- ERP verification (ADR-0004 / 2026-06-18): fired when a
  // CompanyPage / Storefront's ERP-linked badge is removed INVOLUNTARILY because
  // the linked ERP workspace was deleted (the `workspace.deleted` cascade). The
  // entity owner is the recipient; system event (no actor), so NOT user-toggleable
  // -- losing a trust badge silently would be worse. Voluntary unlinks are silent.
  // Keep in sync with ConnectErpLifecycleService (the only emitter) + the web
  // notification route map.
  'connect.erp_badge_removed',
  // ERP -- member cap (lapsed-trial downgrade grandfathering): fired once per
  // (workspace, over-cap episode) when a workspace exceeds its plan's
  // maxMembersPerWorkspace after the grace window. Recipient = the workspace
  // owner; operational/system event (no actor), so NOT user-toggleable -- the
  // owner must always learn their roster is being capped in reports (nothing is
  // deleted). Keep in sync with ErpMemberCapService (the only emitter).
  'erp.member_cap',
  // ERP -- leave/comp-off lifecycle (2026-07-03): applied / decided / closed
  // fan-out to approvers + applicant. Previously used createNotification (row
  // only, no channels) so browser/mobile push never fired; dispatching through
  // the channel pipeline fixes that. Operational workflow event, so NOT
  // user-toggleable. Keep in sync with LeaveNotificationService.fanOut (the
  // only emitter).
  'erp.leave_update',
  // ERP -- salary self-service lifecycle (2026-07-03): advance/loan request
  // received (owner) + decided (worker). Dispatched through the channel
  // pipeline so browser/mobile push fire. Operational workflow event, NOT
  // user-toggleable. Emitters: advance-salary-request.service.ts +
  // loan-request.service.ts.
  'erp.salary_update',
  // Legacy invite notifications (cross-workspace, pre-Connect)
  'INVITE_RECEIVED',
  'INVITE_ACCEPTED',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Categories intentionally HIDDEN from the general notifications bell /
 * notifications-center read + count queries. Messages live in the inbox
 * (which keeps its own separate unread badge) and still fire the live
 * `/notifications` socket event + the `browser_push` channel — so the
 * envelope is still dispatched and persisted; it is only excluded from
 * the bell so a busy 1:1 conversation never floods the bell badge.
 * Applied as a `category: { $nin: [...] }` filter in
 * `NotificationsService.listForUser` / `countUnseenForUser` /
 * `countUnreadForUser`.
 */
export const BELL_HIDDEN_CATEGORIES: ReadonlySet<NotificationCategory> =
  new Set<NotificationCategory>(['connect.message_received']);

/** Categories surfaced in the user-facing preferences UI. Legacy invite
 *  notifications are not user-toggleable (operational events). */
export const USER_TOGGLEABLE_CATEGORIES: NotificationCategory[] = [
  'connect.connection_requested',
  'connect.connection_accepted',
  'connect.followed',
  'connect.post_reacted',
  'connect.post_commented',
  'connect.post_reposted',
  'connect.post_replied',
  'connect.post_mentioned',
  'connect.inquiry_received',
  'connect.page_followed',
  'connect.credential_confirmed',
  'connect.credential_declined',
  'connect.hire_lead_received',
  'connect.introduction_created',
  'connect.introduction_confirmed',
  'connect.job_application_received',
  'connect.job_application_accepted',
  'connect.job_application_declined',
  'connect.message_received',
];

/** Per-channel pref shape. */
export interface ChannelPrefs {
  /** Bell + notifications center + socket push. */
  inPlatform: boolean;
  /** FCM / APNs push to the mobile app. Channel impl ships later. */
  mobilePush: boolean;
  /** Web Push (VAPID) to the browser. Channel impl ships later. */
  browserPush: boolean;
}

/** Default prefs for a brand-new user — every category in-platform-on,
 *  mobile + browser off (until the user opts in once those channels ship). */
export function defaultChannelPrefs(): ChannelPrefs {
  return { inPlatform: true, mobilePush: false, browserPush: false };
}

/** Build a full default-preferences map covering every user-toggleable
 *  category. Stored as the seed when a user has no preferences row yet. */
export function defaultPreferences(): Record<NotificationCategory, ChannelPrefs> {
  return USER_TOGGLEABLE_CATEGORIES.reduce(
    (acc, cat) => {
      acc[cat] = defaultChannelPrefs();
      return acc;
    },
    {} as Record<NotificationCategory, ChannelPrefs>,
  );
}

/* ── Global delivery settings (structure for future channels) ─────────────
 * These live ALONGSIDE the per-category `ChannelPrefs` above. The per-category
 * map stays the module master-mute (inPlatform); these globals describe HOW the
 * user wants to be reached. Only `inApp` is honoured by the dispatcher today
 * (browserPush/whatsapp/email/sms + quietHours are persisted but inert). Drawer
 * UI: features/connect/notifications/PreferencesDrawer.tsx. */
export interface GlobalChannelPrefs {
  inApp: boolean; // always-on; the engine. Cannot be turned off.
  browserPush: boolean;
  whatsapp: boolean;
  email: boolean;
  sms: boolean;
}

export interface QuietHours {
  enabled: boolean;
  start: string; // 'HH:mm'
  end: string; // 'HH:mm'
  tz: string; // IANA zone, e.g. 'Asia/Kolkata'
}

export interface DeliverySettings {
  smartBatching: boolean; // honoured for in-app (existing batching); inert elsewhere
  quietHours: QuietHours; // persisted, NOT enforced yet
}

export function defaultGlobalChannels(): GlobalChannelPrefs {
  return { inApp: true, browserPush: false, whatsapp: false, email: false, sms: false };
}

export function defaultDeliverySettings(): DeliverySettings {
  return {
    smartBatching: true,
    quietHours: { enabled: false, start: '22:00', end: '07:00', tz: 'Asia/Kolkata' },
  };
}
