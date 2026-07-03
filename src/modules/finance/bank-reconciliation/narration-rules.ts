export interface NarrationCategoryRule {
  patterns: RegExp[];
  accountCode: string; // CoA code suggestion
  accountName: string; // human-readable label
  entryType: 'expense' | 'journal' | 'cheque_bounce';
}

export const NARRATION_CATEGORY_RULES: NarrationCategoryRule[] = [
  {
    patterns: [
      /bank.?charge/i,
      /sms.?charg/i,
      /service.?charg/i,
      /annual.?fee/i,
      /minimum.?balance/i,
    ],
    accountCode: '5008',
    accountName: 'Bank Charges',
    entryType: 'expense',
  },
  {
    patterns: [/int.?cr/i, /interest.?cr/i, /saving.?interest/i, /int\.pd/i],
    accountCode: '4003',
    accountName: 'Interest Income',
    entryType: 'journal',
  },
  {
    patterns: [
      /neft.?return/i,
      /imps.?return/i,
      /bounce/i,
      /dishon/i,
      /cheque.?return/i,
    ],
    accountCode: '5014',
    accountName: 'Cheque Bounce Charges',
    entryType: 'cheque_bounce',
  },
  {
    patterns: [/^gst/i, /tax.?deduct/i, /^tds/i],
    accountCode: '2014',
    accountName: 'TDS Receivable',
    entryType: 'journal',
  },
  {
    patterns: [
      /upi.*charges/i,
      /imps.*charges/i,
      /neft.*charges/i,
      /rtgs.*charges/i,
    ],
    accountCode: '5008',
    accountName: 'Bank Charges',
    entryType: 'expense',
  },
];

export interface CategorySuggestion {
  accountCode: string;
  accountName: string;
  entryType: string;
  matchedPattern: string; // for UI to show why this rule fired
}

export function suggestCategory(narrationNorm: string): CategorySuggestion | null {
  for (const rule of NARRATION_CATEGORY_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(narrationNorm)) {
        return {
          accountCode: rule.accountCode,
          accountName: rule.accountName,
          entryType: rule.entryType,
          matchedPattern: pattern.source,
        };
      }
    }
  }
  return null;
}
