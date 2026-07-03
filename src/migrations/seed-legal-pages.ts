import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LegalPage } from '../modules/legal-pages/schemas/legal-page.schema';

/** One seed row — a draft legal document the admin later edits + publishes. */
interface LegalPageSeed {
  slug: string;
  product: 'platform' | 'connect' | 'erp';
  kind: 'terms' | 'privacy' | 'guidelines';
  title: string;
  body: string;
}

/**
 * Starter Markdown skeleton. Seeded as a DRAFT so it is NOT served publicly — the
 * public route falls back to the web placeholder copy until an admin fills this in
 * and publishes. Gives the admin a real structure to edit rather than a blank box.
 */
function skeleton(productLabel: string, kind: 'terms' | 'privacy'): string {
  if (kind === 'terms') {
    return [
      `# ${productLabel} — Terms & Conditions`,
      '',
      '_Draft. Replace this with the official terms before publishing._',
      '',
      '## 1. Introduction',
      '',
      '## 2. Use of the service',
      '',
      '## 3. Accounts & eligibility',
      '',
      '## 4. Payments & subscriptions',
      '',
      '## 5. Acceptable use',
      '',
      '## 6. Limitation of liability',
      '',
      '## 7. Changes to these terms',
      '',
      '## 8. Contact',
      '',
    ].join('\n');
  }
  return [
    `# ${productLabel} — Privacy Policy`,
    '',
    '_Draft. Replace this with the official privacy policy before publishing._',
    '',
    '## 1. Information we collect',
    '',
    '## 2. How we use your information',
    '',
    '## 3. Sharing & disclosure',
    '',
    '## 4. Data retention',
    '',
    '## 5. Your rights',
    '',
    '## 6. Security',
    '',
    '## 7. Changes to this policy',
    '',
    '## 8. Contact',
    '',
  ].join('\n');
}

/**
 * Community Guidelines skeleton (the UGC code of conduct). Required for Google
 * AdSense approval on a user-content platform: it must state what content is
 * prohibited and how violations are handled. Seeded as a DRAFT for Connect; the
 * public route falls back to the placeholder until an admin fills it in + publishes.
 */
function guidelinesSkeleton(productLabel: string): string {
  return [
    `# ${productLabel} — Community Guidelines`,
    '',
    '_Draft. Replace this with the official community guidelines before publishing._',
    '',
    'These guidelines keep ' + productLabel + ' a safe, professional space. They apply',
    'to every post, comment, listing, message, and profile. Breaking them can lead to',
    'content removal, a warning, or account suspension.',
    '',
    '## 1. Be professional and respectful',
    '',
    'No harassment, personal attacks, threats, or doxxing.',
    '',
    '## 2. No hate speech or discrimination',
    '',
    'Content that attacks people by religion, caste, gender, region, or other protected',
    'characteristics is not allowed.',
    '',
    '## 3. No adult, violent, or dangerous content',
    '',
    'No sexually explicit material, graphic violence, or promotion of illegal goods,',
    'weapons, drugs, or malware.',
    '',
    '## 4. No spam, scams, or misleading content',
    '',
    'No deceptive listings, fake reviews, keyword stuffing, or repetitive promotional spam.',
    '',
    '## 5. Post honest, lawful business content',
    '',
    'Job posts must not contain unlawful restrictions (age, gender, caste). Listings must',
    'describe real goods and services.',
    '',
    '## 6. Reporting and enforcement',
    '',
    'Use the Report option on any post, profile, or listing to flag content that breaks',
    'these rules. Our team reviews reports and removes violating content. Repeat or',
    'serious violations lead to suspension.',
    '',
    '## 7. Contact',
    '',
  ].join('\n');
}

/**
 * Company-wide (platform) skeleton. This is the canonical doc the footer links to
 * (/terms, /privacy). Following the "simple website terms + product-specific
 * agreements" pattern, it links OUT to the per-product documents rather than
 * trying to cover everything itself.
 */
function companySkeleton(kind: 'terms' | 'privacy'): string {
  if (kind === 'terms') {
    return [
      '# ManekHR — Terms & Conditions',
      '',
      '_Draft. Replace this with the official company-wide terms before publishing._',
      '',
      '## 1. Introduction',
      '',
      '## 2. Using ManekHR',
      '',
      '## 3. Accounts & eligibility',
      '',
      '## 4. Acceptable use',
      '',
      '## 5. Changes to these terms',
      '',
      '## 6. Contact',
      '',
      '## Product-specific terms',
      '',
      'These website terms cover ManekHR as a whole. Individual products carry their own additional terms:',
      '',
      '- [ManekHR Connect terms](/terms/connect)',
      '- [ManekHR ERP terms](/terms/erp)',
      '',
    ].join('\n');
  }
  return [
    '# ManekHR — Privacy Policy',
    '',
    '_Draft. Replace this with the official company-wide privacy policy before publishing._',
    '',
    '## 1. Information we collect',
    '',
    '## 2. How we use your information',
    '',
    '## 3. Sharing & disclosure',
    '',
    '## 4. Data retention',
    '',
    '## 5. Your rights',
    '',
    '## 6. Security',
    '',
    '## 7. Changes to this policy',
    '',
    '## 8. Contact',
    '',
    '## Product-specific privacy',
    '',
    'This policy covers ManekHR as a whole. Individual products carry their own additional privacy notices:',
    '',
    '- [ManekHR Connect privacy](/privacy/connect)',
    '- [ManekHR ERP privacy](/privacy/erp)',
    '',
  ].join('\n');
}

const SEEDS: LegalPageSeed[] = [
  // Company-wide canonical docs — the footer links here (/terms, /privacy).
  {
    slug: 'terms',
    product: 'platform',
    kind: 'terms',
    title: 'ManekHR — Terms & Conditions',
    body: companySkeleton('terms'),
  },
  {
    slug: 'privacy',
    product: 'platform',
    kind: 'privacy',
    title: 'ManekHR — Privacy Policy',
    body: companySkeleton('privacy'),
  },
  // Product-specific docs (/terms/connect, /privacy/erp, ...).
  {
    slug: 'terms-connect',
    product: 'connect',
    kind: 'terms',
    title: 'ManekHR Connect — Terms & Conditions',
    body: skeleton('ManekHR Connect', 'terms'),
  },
  {
    slug: 'terms-erp',
    product: 'erp',
    kind: 'terms',
    title: 'ManekHR ERP — Terms & Conditions',
    body: skeleton('ManekHR ERP', 'terms'),
  },
  {
    slug: 'privacy-connect',
    product: 'connect',
    kind: 'privacy',
    title: 'ManekHR Connect — Privacy Policy',
    body: skeleton('ManekHR Connect', 'privacy'),
  },
  {
    slug: 'privacy-erp',
    product: 'erp',
    kind: 'privacy',
    title: 'ManekHR ERP — Privacy Policy',
    body: skeleton('ManekHR ERP', 'privacy'),
  },
  // Community Guidelines (UGC code of conduct) — Connect is the user-content
  // surface, so it carries the guidelines required for AdSense approval.
  {
    slug: 'guidelines-connect',
    product: 'connect',
    kind: 'guidelines',
    title: 'ManekHR Connect — Community Guidelines',
    body: guidelinesSkeleton('ManekHR Connect'),
  },
];

/**
 * Seed the legal pages (terms/privacy × platform/connect/erp, plus Connect
 * Community Guidelines) as drafts so the public /terms + /privacy + /guidelines
 * routes always have a row to resolve to once published.
 *
 * Idempotent + re-runnable. Looks up by `slug` and SKIPS when a row exists, so an
 * admin's edits + published content are preserved on re-run. Mirrors
 * `SeedConnectTagsService`. Registered as migration 0047 in MigrationsModule.
 */
@Injectable()
export class SeedLegalPagesService {
  private readonly logger = new Logger(SeedLegalPagesService.name);

  constructor(@InjectModel(LegalPage.name) private readonly legalPageModel: Model<LegalPage>) {}

  async runSeed(): Promise<{ inserted: number; skipped: number }> {
    let inserted = 0;
    let skipped = 0;
    for (const def of SEEDS) {
      const existing = await this.legalPageModel
        .findOne({ slug: def.slug })
        .select('_id')
        .lean<{ _id: unknown } | null>()
        .exec();
      if (existing) {
        skipped += 1;
        continue;
      }
      await this.legalPageModel.create({ ...def, status: 'draft', version: 1 });
      inserted += 1;
    }
    this.logger.log(`Legal pages seed: ${inserted} inserted, ${skipped} skipped.`);
    return { inserted, skipped };
  }
}
