/**
 * Internal Account → Tally primary group mapping (D-04, RESEARCH "COA mapping").
 *
 * Maps the internal `Account.{type, subGroup}` shape to one of Tally's 28
 * pre-seeded primary groups. Static map — no user configuration. Custom
 * sub-groups inherit their parent type's Tally primary.
 *
 * Tally ERP 9 v6.6 and TallyPrime v3.x both ship the same primary group
 * names; mapping is forward-compatible.
 */

export interface AccountForMapping {
  type: 'asset' | 'liability' | 'capital' | 'income' | 'expense' | string;
  subGroup?: string;
  group?: string;
}

/**
 * Resolves a Tally primary group name for an Account.
 *
 * @param account — minimal account shape `{ type, subGroup?, group? }`.
 *                  `subGroup` is matched first against well-known Tally primary
 *                  groups (case-insensitive); `type` is the fallback bucket.
 * @returns Tally primary group name (e.g. 'Sundry Debtors').
 */
export function mapAccountToTallyGroup(account: AccountForMapping): string {
  const sg = (account.subGroup || account.group || '').trim();
  const sgLower = sg.toLowerCase();

  // Direct subGroup matches → these names are already Tally primaries.
  const directMatches: Record<string, string> = {
    'sundry debtors': 'Sundry Debtors',
    'sundry creditors': 'Sundry Creditors',
    'bank accounts': 'Bank Accounts',
    'bank ocd a/c': 'Bank OCD A/c',
    'bank od a/c': 'Bank OD A/c',
    'cash-in-hand': 'Cash-in-Hand',
    'cash in hand': 'Cash-in-Hand',
    'duties & taxes': 'Duties & Taxes',
    'duties and taxes': 'Duties & Taxes',
    'stock-in-hand': 'Stock-in-Hand',
    'stock in hand': 'Stock-in-Hand',
    'fixed assets': 'Fixed Assets',
    'investments': 'Investments',
    'loans (liability)': 'Loans (Liability)',
    'loans & advances (asset)': 'Loans & Advances (Asset)',
    'misc. expenses (asset)': 'Misc. Expenses (Asset)',
    'provisions': 'Provisions',
    'reserves & surplus': 'Reserves & Surplus',
    'retained earnings': 'Reserves & Surplus',
    'secured loans': 'Secured Loans',
    'unsecured loans': 'Unsecured Loans',
    'capital account': 'Capital Account',
    'branch / divisions': 'Branch / Divisions',
    'suspense a/c': 'Suspense A/c',
    'deposits (asset)': 'Deposits (Asset)',
    'current assets': 'Current Assets',
    'current liabilities': 'Current Liabilities',
    'sales accounts': 'Sales Accounts',
    'purchase accounts': 'Purchase Accounts',
    'direct expenses': 'Direct Expenses',
    'indirect expenses': 'Indirect Expenses',
    'direct incomes': 'Direct Incomes',
    'indirect incomes': 'Indirect Incomes',
  };
  if (sgLower && directMatches[sgLower]) return directMatches[sgLower];

  // Fall back to type-based default.
  switch (account.type) {
    case 'asset':
      return 'Current Assets';
    case 'liability':
      return 'Current Liabilities';
    case 'capital':
      return 'Capital Account';
    case 'income':
      return 'Sales Accounts';
    case 'expense':
      return 'Indirect Expenses';
    default:
      return 'Suspense A/c';
  }
}
