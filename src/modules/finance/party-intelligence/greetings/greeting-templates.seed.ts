/**
 * Phase 17 / FIN-16-05 D-28 — default birthday & anniversary greeting templates.
 *
 * 6 entries: 2 kinds (birthday_greeting, anniversary_greeting) × 3 locales
 * (en, gu, hi). Stored as global defaults (workspaceId: null) and seeded once
 * per kind+locale via OnModuleInit upsert keyed on
 * (eventType, language, workspaceId: null, isDefault: true).
 *
 * Variables substituted at send time by GreetingsService.dispatch:
 *   {contactName} {partyName} {firmName} {occasion}
 *
 * Subject (email channel only) per plan spec:
 *   "Wishing you a happy {occasion}, {contactName}!"
 */

export interface GreetingTemplateSeed {
  eventType: 'birthday_greeting' | 'anniversary_greeting';
  language: 'en' | 'gu' | 'hi';
  subject: string;
  body: string;
  variables: string[];
  isDefault: true;
  workspaceId: null;
}

const SUBJECT = 'Wishing you a happy {occasion}, {contactName}!';
const VARIABLES = ['contactName', 'partyName', 'firmName', 'occasion'];

export const GREETING_TEMPLATE_DEFAULTS: GreetingTemplateSeed[] = [
  // ── English ─────────────────────────────────────────────────────────────
  {
    eventType: 'birthday_greeting',
    language: 'en',
    subject: SUBJECT,
    body:
      'Dear {contactName}, wishing you a very happy birthday from all of us at {firmName}. — {firmName}',
    variables: VARIABLES,
    isDefault: true,
    workspaceId: null,
  },
  {
    eventType: 'anniversary_greeting',
    language: 'en',
    subject: SUBJECT,
    body:
      'Dear {contactName}, congratulations on your work anniversary from all of us at {firmName}!',
    variables: VARIABLES,
    isDefault: true,
    workspaceId: null,
  },

  // ── Gujarati ────────────────────────────────────────────────────────────
  {
    eventType: 'birthday_greeting',
    language: 'gu',
    subject: SUBJECT,
    body:
      'પ્રિય {contactName}, {firmName} તરફથી તમને જન્મદિવસની હાર્દિક શુભેચ્છાઓ.',
    variables: VARIABLES,
    isDefault: true,
    workspaceId: null,
  },
  {
    eventType: 'anniversary_greeting',
    language: 'gu',
    subject: SUBJECT,
    body:
      'પ્રિય {contactName}, {firmName} તરફથી તમને વર્ષગાંઠની હાર્દિક શુભેચ્છાઓ.',
    variables: VARIABLES,
    isDefault: true,
    workspaceId: null,
  },

  // ── Hindi ───────────────────────────────────────────────────────────────
  {
    eventType: 'birthday_greeting',
    language: 'hi',
    subject: SUBJECT,
    body:
      'प्रिय {contactName}, {firmName} की ओर से आपको जन्मदिन की हार्दिक शुभकामनाएं।',
    variables: VARIABLES,
    isDefault: true,
    workspaceId: null,
  },
  {
    eventType: 'anniversary_greeting',
    language: 'hi',
    subject: SUBJECT,
    body:
      'प्रिय {contactName}, {firmName} की ओर से आपको वर्षगांठ की हार्दिक बधाई।',
    variables: VARIABLES,
    isDefault: true,
    workspaceId: null,
  },
];

/**
 * Compatibility re-exports for code that thinks of these in plan terminology.
 * Plan uses `kind` and `locale`; codebase uses `eventType` and `language`.
 */
export const GREETING_TEMPLATE_KINDS = [
  'birthday_greeting',
  'anniversary_greeting',
] as const;
export type GreetingTemplateKind = (typeof GREETING_TEMPLATE_KINDS)[number];

export const GREETING_TEMPLATE_LOCALES = ['en', 'gu', 'hi'] as const;
export type GreetingTemplateLocale = (typeof GREETING_TEMPLATE_LOCALES)[number];
