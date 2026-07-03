/**
 * TallyXmlStreamWriter — streaming Tally `<ENVELOPE>` emitter (D-10).
 *
 * Hand-rolled writer (no XML library dependency). Emits a complete
 * `<TALLYMESSAGE>` block per `writeMaster` / `writeVoucher` call so a
 * crashed export does not leave a half-formed message in the output buffer.
 *
 * Output format intentionally uses indentation-free single-line `<TALLYMESSAGE>`
 * blocks separated by `\n`. This makes byte-level golden-file diffing reliable
 * — any future change to escaping, ordering, or field set is detected by the
 * existing fixture suite without whitespace-sensitivity false positives.
 *
 * Usage:
 *   const w = new TallyXmlStreamWriter(filePath, 'Acme Trading Co', 'Vouchers');
 *   await w.openEnvelope();
 *   await w.writeMaster('LEDGER', { ... });
 *   await w.writeVoucher({ ... }, [ledgerLines], [inventoryLines]);
 *   await w.closeEnvelope();
 */
import { createWriteStream, WriteStream } from 'fs';
import { escapeXml } from '../utils/escape-xml';

export type TallyMasterType =
  | 'GROUP'
  | 'LEDGER'
  | 'STOCKGROUP'
  | 'STOCKITEM'
  | 'UNIT';

export type TallyReportName = 'All Masters' | 'Vouchers';

export interface LedgerEntryRow {
  ledgerName: string;
  isDeemedPositive: boolean;
  amount: string; // already formatted via paiseToTallyAmount()
}

export interface InventoryEntryRow {
  stockItemName: string;
  isDeemedPositive: boolean;
  rate?: string; // "ratePerUnit/{unit}"
  actualQty?: string; // e.g. "10 NOS"
  billedQty?: string;
  amount: string;
  rateOfGst?: number;
  hsnCode?: string;
  taxability?: 'Taxable' | 'Exempt' | 'Nil Rated';
  batchAllocations?: Array<{
    batchName: string;
    godownName: string;
    amount: string;
    actualQty: string;
    billedQty: string;
  }>;
}

export interface TallyVoucherRow {
  guid: string;
  vchType: string; // mapped Tally voucher type (Sales / Purchase / Receipt / …)
  date: string; // YYYYMMDD
  voucherNumber: string;
  partyLedgerName?: string;
  partyGstin?: string;
  placeOfSupply?: string;
  narration?: string;
  isInvoice: boolean;
  reference?: string;
}

export class TallyXmlStreamWriter {
  private stream: WriteStream;
  private opened = false;
  private closed = false;

  constructor(
    private readonly filePath: string,
    private readonly companyName: string,
    private readonly reportName: TallyReportName = 'Vouchers',
  ) {
    this.stream = createWriteStream(filePath, { encoding: 'utf8' });
  }

  /** Returns the destination file path (helpful for caller streaming). */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Opens the envelope: emits `<?xml ?>` prolog, `<ENVELOPE>`, header, and
   * the body up to (but not including) the first `<TALLYMESSAGE>`.
   */
  async openEnvelope(): Promise<void> {
    if (this.opened) {
      throw new Error('TallyXmlStreamWriter: openEnvelope called twice');
    }
    this.opened = true;
    await this.write(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ENVELOPE>` +
        `<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
        `<BODY><IMPORTDATA>` +
        `<REQUESTDESC>` +
        `<REPORTNAME>${escapeXml(this.reportName)}</REPORTNAME>` +
        `<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(this.companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>` +
        `</REQUESTDESC>` +
        `<REQUESTDATA>\n`,
    );
  }

  /**
   * Emits a single master record (GROUP / LEDGER / STOCKGROUP / STOCKITEM / UNIT)
   * wrapped in its own `<TALLYMESSAGE>` block.
   *
   * Children are rendered in insertion order; values are XML-escaped.
   * Pass `__action__` in the record to control the `ACTION="..."` attribute
   * (default: `Create`).
   */
  async writeMaster(
    type: TallyMasterType,
    record: { name: string; alterId?: string; children?: Array<[string, string | number]>; action?: string },
  ): Promise<void> {
    this.assertReadyForBody();
    const action = record.action ?? 'Create';
    let xml = `<TALLYMESSAGE xmlns:UDF="TallyUDF">`;
    xml += `<${type} NAME="${escapeXml(record.name)}" ACTION="${escapeXml(action)}">`;
    for (const [tag, val] of record.children ?? []) {
      xml += `<${tag}>${escapeXml(String(val))}</${tag}>`;
    }
    if (record.alterId) {
      xml += `<ALTERID>${escapeXml(record.alterId)}</ALTERID>`;
    }
    xml += `</${type}>`;
    xml += `</TALLYMESSAGE>\n`;
    await this.write(xml);
  }

  /**
   * Emits a voucher TALLYMESSAGE with its ledger entries (and optional
   * inventory entries for Sales/Purchase/CN/DN/Stock Journal vouchers).
   */
  async writeVoucher(
    voucher: TallyVoucherRow,
    ledgerEntries: LedgerEntryRow[],
    inventoryEntries?: InventoryEntryRow[],
  ): Promise<void> {
    this.assertReadyForBody();
    let xml = `<TALLYMESSAGE xmlns:UDF="TallyUDF">`;
    xml += `<VOUCHER REMOTEID="${escapeXml(voucher.guid)}" VCHKEY="${escapeXml(voucher.guid)}" VCHTYPE="${escapeXml(voucher.vchType)}" ACTION="Create" OBJVIEW="${voucher.isInvoice ? 'Invoice Voucher View' : 'Accounting Voucher View'}">`;
    xml += `<DATE>${escapeXml(voucher.date)}</DATE>`;
    xml += `<GUID>${escapeXml(voucher.guid)}</GUID>`;
    xml += `<VOUCHERTYPENAME>${escapeXml(voucher.vchType)}</VOUCHERTYPENAME>`;
    xml += `<VOUCHERNUMBER>${escapeXml(voucher.voucherNumber)}</VOUCHERNUMBER>`;
    if (voucher.reference) {
      xml += `<REFERENCE>${escapeXml(voucher.reference)}</REFERENCE>`;
    }
    if (voucher.partyLedgerName) {
      xml += `<PARTYLEDGERNAME>${escapeXml(voucher.partyLedgerName)}</PARTYLEDGERNAME>`;
    }
    xml += `<NARRATION>${escapeXml(voucher.narration ?? '')}</NARRATION>`;
    xml += `<ISINVOICE>${voucher.isInvoice ? 'Yes' : 'No'}</ISINVOICE>`;
    if (voucher.partyGstin) {
      xml += `<PARTYGSTIN>${escapeXml(voucher.partyGstin)}</PARTYGSTIN>`;
    }
    if (voucher.placeOfSupply) {
      xml += `<PLACEOFSUPPLY>${escapeXml(voucher.placeOfSupply)}</PLACEOFSUPPLY>`;
    }

    // Ledger entries
    for (const le of ledgerEntries) {
      xml += `<ALLLEDGERENTRIES.LIST>`;
      xml += `<LEDGERNAME>${escapeXml(le.ledgerName)}</LEDGERNAME>`;
      xml += `<ISDEEMEDPOSITIVE>${le.isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`;
      xml += `<AMOUNT>${escapeXml(le.amount)}</AMOUNT>`;
      xml += `</ALLLEDGERENTRIES.LIST>`;
    }

    // Inventory entries (optional)
    if (inventoryEntries && inventoryEntries.length > 0) {
      for (const inv of inventoryEntries) {
        xml += `<ALLINVENTORYENTRIES.LIST>`;
        xml += `<STOCKITEMNAME>${escapeXml(inv.stockItemName)}</STOCKITEMNAME>`;
        xml += `<ISDEEMEDPOSITIVE>${inv.isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`;
        if (inv.rate) xml += `<RATE>${escapeXml(inv.rate)}</RATE>`;
        if (inv.actualQty) xml += `<ACTUALQTY>${escapeXml(inv.actualQty)}</ACTUALQTY>`;
        if (inv.billedQty) xml += `<BILLEDQTY>${escapeXml(inv.billedQty)}</BILLEDQTY>`;
        xml += `<AMOUNT>${escapeXml(inv.amount)}</AMOUNT>`;
        if (inv.batchAllocations && inv.batchAllocations.length > 0) {
          for (const b of inv.batchAllocations) {
            xml += `<BATCHALLOCATIONS.LIST>`;
            xml += `<BATCHNAME>${escapeXml(b.batchName)}</BATCHNAME>`;
            xml += `<GODOWNNAME>${escapeXml(b.godownName)}</GODOWNNAME>`;
            xml += `<AMOUNT>${escapeXml(b.amount)}</AMOUNT>`;
            xml += `<ACTUALQTY>${escapeXml(b.actualQty)}</ACTUALQTY>`;
            xml += `<BILLEDQTY>${escapeXml(b.billedQty)}</BILLEDQTY>`;
            xml += `</BATCHALLOCATIONS.LIST>`;
          }
        }
        if (typeof inv.rateOfGst === 'number') {
          xml += `<RATEOFGST>${escapeXml(String(inv.rateOfGst))}</RATEOFGST>`;
        }
        if (inv.hsnCode) xml += `<HSNCODE>${escapeXml(inv.hsnCode)}</HSNCODE>`;
        if (inv.taxability) xml += `<TAXABILITY>${escapeXml(inv.taxability)}</TAXABILITY>`;
        xml += `</ALLINVENTORYENTRIES.LIST>`;
      }
    }

    xml += `</VOUCHER>`;
    xml += `</TALLYMESSAGE>\n`;
    await this.write(xml);
  }

  /** Closes the envelope and awaits the underlying stream's `finish` event. */
  async closeEnvelope(): Promise<void> {
    if (this.closed) return;
    if (!this.opened) {
      throw new Error('TallyXmlStreamWriter: closeEnvelope without openEnvelope');
    }
    this.closed = true;
    await this.write(
      `</REQUESTDATA>` + `</IMPORTDATA></BODY>` + `</ENVELOPE>\n`,
    );
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err: any) => (err ? reject(err) : resolve()));
    });
  }

  private assertReadyForBody(): void {
    if (!this.opened) {
      throw new Error('TallyXmlStreamWriter: writeMaster/writeVoucher before openEnvelope');
    }
    if (this.closed) {
      throw new Error('TallyXmlStreamWriter: write after closeEnvelope');
    }
  }

  private write(s: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ok = this.stream.write(s, (err) => {
        if (err) reject(err);
      });
      if (ok) {
        resolve();
      } else {
        this.stream.once('drain', () => resolve());
      }
    });
  }
}
