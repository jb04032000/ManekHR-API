/**
 * MastersGenerator — emits the masters section of a Tally export envelope
 * in the mandatory ordering (D-03):
 *   1. Custom GROUPs (only those not in the Tally primary list)
 *   2. LEDGERs (every Account referenced + party ledgers + 4 tax ledgers)
 *   3. STOCKGROUPs (custom only)
 *   4. UNITs
 *   5. STOCKITEMs (with HSN/GST/RATE)
 */
import { Injectable } from '@nestjs/common';
import { TallyXmlStreamWriter } from './envelope.writer';
import { mapAccountToTallyGroup, AccountForMapping } from '../mappings/coa-mapping';
import { TAX_LEDGERS } from '../mappings/gst-tax-ledger.constants';
import { PreExportValidator } from '../validators/pre-export-validator.service';

export interface MasterAccount extends AccountForMapping {
  _id: string;
  name: string;
}

export interface MasterParty {
  _id: string;
  name: string;
  partyType: 'customer' | 'vendor' | 'broker' | 'transporter' | 'employee_advance' | string;
  gstin?: string;
}

export interface MasterStockItem {
  _id: string;
  name: string;
  unit: string;
  hsnSacCode?: string;
  gstRate?: number;
}

/**
 * Tally primary group names — exporter MUST NOT emit these as `<GROUP>`
 * masters because Tally pre-seeds them. Any custom group whose name is not
 * in this set is emitted under the parent's primary.
 */
const TALLY_PRIMARY_GROUPS = new Set<string>([
  'Capital Account',
  'Reserves & Surplus',
  'Loans (Liability)',
  'Bank OD A/c',
  'Bank OCD A/c',
  'Secured Loans',
  'Unsecured Loans',
  'Branch / Divisions',
  'Current Liabilities',
  'Duties & Taxes',
  'Provisions',
  'Sundry Creditors',
  'Suspense A/c',
  'Fixed Assets',
  'Investments',
  'Current Assets',
  'Loans & Advances (Asset)',
  'Stock-in-Hand',
  'Deposits (Asset)',
  'Misc. Expenses (Asset)',
  'Bank Accounts',
  'Cash-in-Hand',
  'Sundry Debtors',
  'Sales Accounts',
  'Direct Incomes',
  'Indirect Incomes',
  'Purchase Accounts',
  'Direct Expenses',
  'Indirect Expenses',
]);

@Injectable()
export class MastersGenerator {
  /**
   * Emits the full masters section into the open writer.
   *
   * Caller must `openEnvelope()` before and `closeEnvelope()` after.
   *
   * Ordering: GROUP → LEDGER (accounts + tax ledgers + parties) → UNIT → STOCKITEM.
   * STOCKGROUPs omitted in MVP (no custom stock groups in repo schema today).
   */
  async streamMasters(
    writer: TallyXmlStreamWriter,
    data: {
      accounts: MasterAccount[];
      parties: MasterParty[];
      stockItems: MasterStockItem[];
    },
  ): Promise<void> {
    // 1. GROUP — only custom groups not in Tally primaries
    const seenGroups = new Set<string>();
    for (const a of data.accounts) {
      const candidate = (a.subGroup || a.group || '').trim();
      if (
        candidate &&
        !TALLY_PRIMARY_GROUPS.has(candidate) &&
        !seenGroups.has(candidate)
      ) {
        const parent = mapAccountToTallyGroup({ type: a.type, subGroup: '' });
        await writer.writeMaster('GROUP', {
          name: candidate,
          children: [['PARENT', parent]],
        });
        seenGroups.add(candidate);
      }
    }

    // 2a. Tax ledgers (CGST/SGST/IGST/CESS) — always emitted
    for (const t of TAX_LEDGERS) {
      await writer.writeMaster('LEDGER', {
        name: t.name,
        children: [
          ['PARENT', t.parentGroup],
          ['TAXTYPE', t.taxType],
          ['DUTYHEAD', t.dutyHead],
        ],
      });
    }

    // 2b. Account ledgers (skip names already used by tax ledgers)
    const taxNames = new Set(TAX_LEDGERS.map((t) => t.name));
    for (const a of data.accounts) {
      if (taxNames.has(a.name)) continue;
      const parentGroup = mapAccountToTallyGroup(a);
      await writer.writeMaster('LEDGER', {
        name: PreExportValidator.truncateLedgerName(a.name),
        alterId: a._id,
        children: [['PARENT', parentGroup]],
      });
    }

    // 2c. Party ledgers — customers go under Sundry Debtors; vendors under Sundry Creditors.
    for (const p of data.parties) {
      const parent =
        p.partyType === 'vendor'
          ? 'Sundry Creditors'
          : p.partyType === 'customer'
            ? 'Sundry Debtors'
            : 'Sundry Debtors';
      const children: Array<[string, string | number]> = [['PARENT', parent]];
      if (p.gstin) children.push(['PARTYGSTIN', p.gstin]);
      await writer.writeMaster('LEDGER', {
        name: PreExportValidator.truncateLedgerName(p.name),
        alterId: p._id,
        children,
      });
    }

    // 3. UNITs — unique units across all stock items
    const seenUnits = new Set<string>();
    for (const item of data.stockItems) {
      if (item.unit && !seenUnits.has(item.unit)) {
        await writer.writeMaster('UNIT', {
          name: item.unit,
          children: [['ISSIMPLEUNIT', 'Yes']],
        });
        seenUnits.add(item.unit);
      }
    }

    // 4. STOCKITEMs
    for (const item of data.stockItems) {
      const children: Array<[string, string | number]> = [
        ['BASEUNITS', item.unit || 'NOS'],
        ['GSTAPPLICABLE', 'Applicable'],
      ];
      if (item.hsnSacCode) children.push(['HSNCODE', item.hsnSacCode]);
      if (typeof item.gstRate === 'number') children.push(['RATEOFGST', item.gstRate]);
      await writer.writeMaster('STOCKITEM', {
        name: item.name,
        alterId: item._id,
        children,
      });
    }
  }
}
