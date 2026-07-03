import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';

// ── Interfaces ─────────────────────────────────────

interface PayslipBranding {
  includeHeaderLogo: boolean;
  headerLogoUrl?: string;
  includeWatermark: boolean;
  watermarkLogoUrl?: string;
  includeFooter: boolean;
  footerText?: string;
  showExportDate?: boolean;
}

interface CurrencyConfig {
  symbol: string;
  locale: string;
  code: string;
}

interface ComponentInput {
  id: string;
  name: string;
  calcMode: 'percent_of_ctc' | 'percent_of_component' | 'fixed' | 'balancing';
  value?: number;
  referenceComponentId?: string;
  includedInCtc: boolean;
  isBasicComponent: boolean;
  sortOrder: number;
}

interface ComponentOverride {
  componentId: string;
  calcMode?: string;
  value?: number;
}

interface CalculatedComponent {
  componentId: string;
  name: string;
  calculatedAmount: number;
  isBasicComponent: boolean;
  includedInCtc: boolean;
}

export interface PayslipRecord {
  _id?: string;
  month: number;
  year: number;
  baseSalary?: number;
  totalDays?: number;
  presentDays?: number;
  netSalary?: number;
  status?: string;
  salaryDayBasis?: string;
  fixedMonthDays?: number;
  attendancePayModeApplied?: string;
  teamMemberId?: any;
  teamMember?: {
    _id?: string;
    id?: string;
    name?: string;
    designation?: string;
    email?: string;
    mobile?: string;
    employeeCode?: string;
    salaryType?: string;
    ctcAmount?: number;
    componentTemplateId?: string;
    componentOverrides?: ComponentOverride[];
  };
  paidAmount?: number;
}

export interface PayslipAdjustment {
  type: 'addition' | 'deduction';
  status: 'active' | 'reversed';
  category: string;
  amount: number;
  reasonTitle?: string;
  month: number;
  year: number;
}

export interface PayslipPayment {
  amount: number;
  commission?: number;
  paymentDate: string | Date;
  paymentMode?: string;
  referenceNo?: string;
  status?: string;
}

export interface PayslipComponentTemplate {
  _id?: string;
  name: string;
  components: ComponentInput[];
}

export interface PayslipData {
  record: PayslipRecord;
  adjustments: PayslipAdjustment[];
  payments: PayslipPayment[];
  componentTemplate?: PayslipComponentTemplate | null;
  workspaceName: string;
  branding?: PayslipBranding;
  currencyConfig?: CurrencyConfig;
  /**
   * Informational only. Outstanding salary advance balance as of this payslip.
   * Rendered as a note below the payment history table.
   * Does NOT affect net salary.
   */
  advanceOutstanding?: number;
  /**
   * Informational only. Outstanding employer loan balance as of this payslip.
   * Rendered as a note below the payment history table.
   * Does NOT affect net salary.
   */
  loanOutstanding?: number;
}

// ── Constants ──────────────────────────────────────

const PAGE_WIDTH = 595.28; // A4 portrait in points
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 40; // ~14mm
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;
const FOOTER_RESERVED = 24;
const CONTENT_BOTTOM = PAGE_HEIGHT - FOOTER_RESERVED - 18;

const BRAND_COLOR_DEFAULT: [number, number, number] = [79, 70, 229]; // #4F46E5
const COLOR_DARK: [number, number, number] = [25, 25, 25];
const COLOR_MUTED: [number, number, number] = [95, 99, 104];
const COLOR_LIGHT_BG: [number, number, number] = [248, 249, 250];
const COLOR_ALT_ROW: [number, number, number] = [246, 248, 251];
const COLOR_BORDER: [number, number, number] = [215, 218, 224];

const STATUS_COLORS: Record<string, [number, number, number]> = {
  paid: [22, 163, 74],
  partial: [217, 119, 6],
  pending: [220, 38, 38],
  advance: [37, 99, 235],
};

const PDF_SYMBOL_MAP: Record<string, string> = {
  '₹': 'Rs.',
  '¥': 'Y',
  '₩': 'W',
  '₫': 'VND',
  '₦': 'NGN',
  '₱': 'PHP',
  '₴': 'UAH',
  '₸': 'KZT',
  '₺': 'TRY',
  '₼': 'AZN',
  '₽': 'RUB',
};

// ── Helpers ────────────────────────────────────────

function rgbHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCategory(cat: string): string {
  return cat
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getPdfSafeSymbol(symbol: string): string {
  return PDF_SYMBOL_MAP[symbol] ?? symbol;
}

function formatCurrencyFull(amount: number, symbol = 'Rs.', locale = 'en-IN'): string {
  return `${symbol}${Number(amount ?? 0).toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function makePdfCurrencyFormatter(config?: CurrencyConfig) {
  const safeSymbol = getPdfSafeSymbol(config?.symbol || '₹');
  const space = safeSymbol.length > 1 ? ' ' : '';
  const locale = config?.locale || 'en-IN';
  return {
    full: (amount: number) => formatCurrencyFull(amount, safeSymbol + space, locale),
  };
}

function getMonthName(month: number): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return months[(month - 1) % 12] || 'Unknown';
}

function getPeriodLabel(record: PayslipRecord): string {
  return `${getMonthName(record.month)} ${record.year}`;
}

function getDaysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

function getSalaryBasisLabel(record: PayslipRecord): string {
  if (record.salaryDayBasis === 'calendar_month_days') {
    const basisDays = record.totalDays || getDaysInMonth(record.month, record.year);
    return `Calendar ${basisDays} days`;
  }
  const fixedDays = record.fixedMonthDays ?? record.totalDays ?? 0;
  return `Fixed ${fixedDays} days`;
}

function getAttendanceModeLabel(record: PayslipRecord): string {
  return record.attendancePayModeApplied === 'disabled' ? 'Ignored' : 'Attendance based';
}

function getMemberSnapshot(record: PayslipRecord) {
  if (record.teamMember) return record.teamMember;
  if (typeof record.teamMemberId === 'string') {
    return { id: record.teamMemberId } as any;
  }
  return {
    id: record.teamMemberId?._id,
    name: record.teamMemberId?.name,
    designation: record.teamMemberId?.designation,
  };
}

function getEmployeeName(record: PayslipRecord): string {
  return getMemberSnapshot(record).name || 'Employee';
}

function getEmployeeIdDisplay(record: PayslipRecord): string {
  const member = getMemberSnapshot(record);
  if (member.employeeCode) return member.employeeCode;
  const rawId = member.id || member._id || '';
  if (!rawId) return '—';
  return String(rawId).slice(-6).toUpperCase();
}

function getNetPay(record: PayslipRecord, additionsTotal: number, deductionsTotal: number): number {
  if (Number.isFinite(record.netSalary)) return record.netSalary;
  return (record.baseSalary || 0) + additionsTotal - deductionsTotal;
}

function getPaidAmount(record: PayslipRecord, payments: PayslipPayment[]): number {
  if (typeof record.paidAmount === 'number') return record.paidAmount;
  return payments
    .filter((p) => p.status !== 'reversed')
    .reduce((sum, p) => sum + p.amount + (p.commission || 0), 0);
}

function formatPaymentDate(date: string | Date): string {
  const d = new Date(date);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

// ── Component Calculator (ported from frontend) ───

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function topologicalSort(components: ComponentInput[]): ComponentInput[] {
  const idSet = new Set(components.map((c) => c.id));
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const comp of components) {
    if (!inDegree.has(comp.id)) inDegree.set(comp.id, 0);
    if (!adj.has(comp.id)) adj.set(comp.id, []);
  }

  for (const comp of components) {
    if (
      comp.calcMode === 'percent_of_component' &&
      comp.referenceComponentId &&
      idSet.has(comp.referenceComponentId)
    ) {
      adj.get(comp.referenceComponentId).push(comp.id);
      inDegree.set(comp.id, (inDegree.get(comp.id) || 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: ComponentInput[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const comp = components.find((c) => c.id === current);
    if (comp) sorted.push(comp);
    for (const neighbor of adj.get(current) || []) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

function calculateComponents(
  ctcAmount: number,
  components: ComponentInput[],
  overrides?: ComponentOverride[],
): { breakdown: CalculatedComponent[] } {
  const sorted = [...components].sort((a, b) => a.sortOrder - b.sortOrder);
  const working = sorted.map((comp) => ({ ...comp }));

  if (overrides?.length) {
    for (const override of overrides) {
      const idx = working.findIndex((c) => c.id === override.componentId);
      if (idx !== -1) {
        if (override.calcMode !== undefined) {
          working[idx].calcMode = override.calcMode as ComponentInput['calcMode'];
        }
        if (override.value !== undefined) {
          working[idx].value = override.value;
        }
      }
    }
  }

  const calculated = new Map<string, number>();
  const results: CalculatedComponent[] = [];
  const nonBalancing = working.filter((c) => c.calcMode !== 'balancing');
  const balancingComp = working.find((c) => c.calcMode === 'balancing');
  const topoOrder = topologicalSort(nonBalancing);

  for (const comp of topoOrder) {
    let amount = 0;
    switch (comp.calcMode) {
      case 'percent_of_ctc':
        amount = roundCurrency((ctcAmount * (comp.value ?? 0)) / 100);
        break;
      case 'percent_of_component': {
        const refAmount = calculated.get(comp.referenceComponentId) ?? 0;
        amount = roundCurrency((refAmount * (comp.value ?? 0)) / 100);
        break;
      }
      case 'fixed':
        amount = comp.value ?? 0;
        break;
    }
    calculated.set(comp.id, amount);
    results.push({
      componentId: comp.id,
      name: comp.name,
      calculatedAmount: amount,
      isBasicComponent: comp.isBasicComponent,
      includedInCtc: comp.includedInCtc,
    });
  }

  if (balancingComp) {
    const sumIncluded = results
      .filter((r) => r.includedInCtc)
      .reduce((sum, r) => sum + r.calculatedAmount, 0);
    let balance = roundCurrency(ctcAmount - sumIncluded);
    if (balance < 0) balance = 0;
    results.push({
      componentId: balancingComp.id,
      name: balancingComp.name,
      calculatedAmount: balance,
      isBasicComponent: balancingComp.isBasicComponent,
      includedInCtc: balancingComp.includedInCtc,
    });
  }

  results.sort((a, b) => {
    const idxA = working.findIndex((c) => c.id === a.componentId);
    const idxB = working.findIndex((c) => c.id === b.componentId);
    return idxA - idxB;
  });

  return { breakdown: results };
}

// ── Image Fetcher ──────────────────────────────────

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

// ── PDF Table Drawing ──────────────────────────────

interface TableColumn {
  width: number;
  align: 'left' | 'right' | 'center';
}

interface TableRow {
  cells: string[];
  bold?: boolean;
  muted?: boolean;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  columns: TableColumn[],
  header: string[],
  rows: TableRow[],
  brandColor: [number, number, number],
): number {
  const rowHeight = 20;
  const headerHeight = 22;
  const cellPadding = 8;
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
  let cursorY = y;

  // Header
  doc.save().rect(x, cursorY, tableWidth, headerHeight).fill(rgbHex(brandColor));

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
  let cellX = x;
  for (let i = 0; i < header.length; i++) {
    const col = columns[i];
    const textX = col.align === 'right' ? cellX + col.width - cellPadding : cellX + cellPadding;
    doc.text(header[i], textX, cursorY + 6, {
      width: col.width - 2 * cellPadding,
      align: col.align,
    });
    cellX += col.width;
  }
  doc.restore();
  cursorY += headerHeight;

  // Body rows
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    // Check page break
    if (cursorY + rowHeight > CONTENT_BOTTOM) {
      doc.addPage();
      cursorY = 40;
    }

    const row = rows[rowIdx];
    const isAlt = rowIdx % 2 === 1;

    // Row background
    if (isAlt) {
      doc.save().rect(x, cursorY, tableWidth, rowHeight).fill(rgbHex(COLOR_ALT_ROW)).restore();
    }

    // Row border
    doc
      .save()
      .moveTo(x, cursorY + rowHeight)
      .lineTo(x + tableWidth, cursorY + rowHeight)
      .strokeColor(rgbHex(COLOR_BORDER))
      .lineWidth(0.5)
      .stroke()
      .restore();

    // Cell text
    const fontName = row.bold ? 'Helvetica-Bold' : 'Helvetica';
    const textColor = row.muted ? '#969696' : '#282828';
    doc.font(fontName).fontSize(8).fillColor(textColor);

    cellX = x;
    for (let i = 0; i < row.cells.length; i++) {
      const col = columns[i];
      const textX = col.align === 'right' ? cellX + col.width - cellPadding : cellX + cellPadding;
      doc.text(row.cells[i] || '', textX, cursorY + 6, {
        width: col.width - 2 * cellPadding,
        align: col.align,
      });
      cellX += col.width;
    }
    cursorY += rowHeight;
  }

  return cursorY;
}

// ── Service ────────────────────────────────────────

@Injectable()
export class PayslipPdfService {
  private readonly logger = new Logger(PayslipPdfService.name);

  async generatePayslipBuffer(data: PayslipData): Promise<Buffer> {
    // eslint-disable-next-line no-async-promise-executor, @typescript-eslint/no-misused-promises
    return new Promise<Buffer>(async (resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margins: {
            top: 28,
            bottom: FOOTER_RESERVED,
            left: MARGIN_X,
            right: MARGIN_X,
          },
          bufferPages: true,
          info: {
            Title: `Payslip - ${getEmployeeName(data.record)} - ${getPeriodLabel(data.record)}`,
            Author: data.workspaceName,
          },
        });

        const buffers: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        await this.renderPayslip(doc, data);

        // Apply page decorations (footer, watermark) to all pages
        const pageRange = doc.bufferedPageRange();
        for (let i = 0; i < pageRange.count; i++) {
          doc.switchToPage(i);
          this.drawPageDecoration(doc, i + 1, pageRange.count, data.branding);
        }

        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  getPayslipFilename(data: PayslipData): string {
    const employeeName = sanitizeFilenamePart(getEmployeeName(data.record));
    const period = getPeriodLabel(data.record).replace(/\s+/g, '_');
    return `Payslip_${employeeName}_${period}.pdf`;
  }

  private drawPageDecoration(
    doc: PDFKit.PDFDocument,
    pageNumber: number,
    totalPages: number,
    branding?: PayslipBranding,
  ): void {
    const footerLineY = PAGE_HEIGHT - FOOTER_RESERVED;

    // Footer background
    doc
      .save()
      .rect(0, footerLineY - 3, PAGE_WIDTH, FOOTER_RESERVED + 3)
      .fill(rgbHex(COLOR_LIGHT_BG))
      .restore();

    // Footer line
    doc
      .save()
      .moveTo(0, footerLineY - 3)
      .lineTo(PAGE_WIDTH, footerLineY - 3)
      .strokeColor(rgbHex(BRAND_COLOR_DEFAULT))
      .lineWidth(1)
      .stroke()
      .restore();

    // Footer text
    if (branding?.includeFooter && branding.footerText) {
      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor('#646464')
        .text(branding.footerText, MARGIN_X, footerLineY + 4, {
          width: PAGE_WIDTH * 0.4,
        });
    }

    // Computer-generated disclaimer
    doc
      .font('Helvetica-Oblique')
      .fontSize(6)
      .fillColor('#8C8C8C')
      .text(
        'This is a computer-generated document and does not require a signature.',
        0,
        footerLineY + 4,
        { width: PAGE_WIDTH, align: 'center' },
      );

    // Page number
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor('#646464')
      .text(`Page ${pageNumber} of ${totalPages}`, 0, footerLineY + 4, {
        width: PAGE_WIDTH - MARGIN_X,
        align: 'right',
      });
  }

  private async renderPayslip(doc: PDFKit.PDFDocument, data: PayslipData): Promise<void> {
    const brandColor = BRAND_COLOR_DEFAULT;
    const periodLabel = getPeriodLabel(data.record);
    const member = getMemberSnapshot(data.record);
    const designation = member.designation || '—';
    const salaryMode = titleCase(member.salaryType || 'monthly');
    const employeeName = getEmployeeName(data.record);
    const currencyFmt = makePdfCurrencyFormatter(data.currencyConfig);

    const additions = data.adjustments.filter(
      (a) => a.type === 'addition' && a.status === 'active',
    );
    const deductions = data.adjustments.filter(
      (a) => a.type === 'deduction' && a.status === 'active',
    );
    const activePayments = data.payments.filter((p) => p.status !== 'reversed');

    let cursorY = 28;

    // ── Header Logo ─────────────────────────────
    if (data.branding?.includeHeaderLogo && data.branding.headerLogoUrl) {
      const logoBuffer = await fetchImageBuffer(data.branding.headerLogoUrl);
      if (logoBuffer) {
        try {
          const maxLogoW = CONTENT_WIDTH * 0.85;
          const maxLogoH = 80; // ~28mm
          const logoX = MARGIN_X + (CONTENT_WIDTH - maxLogoW) / 2;
          doc.image(logoBuffer, logoX, cursorY, {
            fit: [maxLogoW, maxLogoH],
            align: 'center',
          });
          cursorY += maxLogoH + 6;

          // Divider line under logo
          doc
            .save()
            .moveTo(MARGIN_X, cursorY)
            .lineTo(PAGE_WIDTH - MARGIN_X, cursorY)
            .strokeColor(rgbHex(brandColor))
            .lineWidth(1.5)
            .stroke()
            .restore();
          cursorY += 18;
        } catch (err) {
          this.logger.warn('Failed to add logo to payslip', err);
          cursorY = 28;
        }
      }
    }

    // ── Title: PAYSLIP ──────────────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(17)
      .fillColor(rgbHex(COLOR_DARK))
      .text('PAYSLIP', MARGIN_X, cursorY, {
        width: CONTENT_WIDTH,
        align: 'center',
      });

    // Status badge (right-aligned)
    const statusLabel = titleCase(data.record.status || 'pending');
    const statusClr = STATUS_COLORS[data.record.status || ''] ?? [100, 100, 100];
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(rgbHex(statusClr))
      .text(statusLabel, PAGE_WIDTH - MARGIN_X - 60, cursorY + 3, {
        width: 60,
        align: 'right',
      });

    cursorY += 22;

    // ── Workspace name + period ─────────────────
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(rgbHex(COLOR_DARK))
      .text(data.workspaceName, MARGIN_X, cursorY);

    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor(rgbHex(COLOR_DARK))
      .text(periodLabel, MARGIN_X, cursorY, {
        width: CONTENT_WIDTH,
        align: 'right',
      });

    if (data.branding?.showExportDate ?? true) {
      const now = new Date();
      const exportedAt = `${String(now.getDate()).padStart(2, '0')} ${
        ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
          now.getMonth()
        ]
      } ${now.getFullYear()}, ${String(now.getHours() % 12 || 12).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${now.getHours() >= 12 ? 'PM' : 'AM'}`;

      doc
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#969696')
        .text(`Generated: ${exportedAt}`, MARGIN_X, cursorY + 14, {
          width: CONTENT_WIDTH,
          align: 'right',
        });
    }

    cursorY += 30;

    // ── Employee Info Box ────────────────────────
    const infoRows: Array<{ left: [string, string]; right: [string, string] }> = [
      {
        left: ['Employee', employeeName],
        right: ['Designation', designation],
      },
      {
        left: ['Employee ID', getEmployeeIdDisplay(data.record)],
        right: ['Pay Period', periodLabel],
      },
      {
        left: ['Salary Mode', salaryMode],
        right: ['Salary Basis', getSalaryBasisLabel(data.record)],
      },
    ];
    if (member.email || member.mobile) {
      infoRows.push({
        left: ['Email', member.email || '—'],
        right: ['Phone', member.mobile || '—'],
      });
    }

    const rowHeight = 22;
    const infoBoxH = 10 + infoRows.length * rowHeight;

    // Background + border
    doc
      .save()
      .roundedRect(MARGIN_X, cursorY, CONTENT_WIDTH, infoBoxH, 4)
      .fillAndStroke(rgbHex(COLOR_LIGHT_BG), '#E6E9EE')
      .restore();

    const leftX = MARGIN_X + 10;
    const rightX = MARGIN_X + CONTENT_WIDTH / 2 + 10;
    const valueOffset = 70;

    infoRows.forEach((row, i) => {
      const y = cursorY + 16 + i * rowHeight;

      // Left column
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(rgbHex(COLOR_MUTED));
      doc.text(row.left[0], leftX, y);
      doc.font('Helvetica').fillColor(rgbHex(COLOR_DARK));
      doc.text(row.left[1], leftX + valueOffset, y, {
        width: CONTENT_WIDTH / 2 - valueOffset - 20,
      });

      // Right column
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(rgbHex(COLOR_MUTED));
      doc.text(row.right[0], rightX, y);
      doc.font('Helvetica').fillColor(rgbHex(COLOR_DARK));
      doc.text(row.right[1], rightX + valueOffset, y, {
        width: CONTENT_WIDTH / 2 - valueOffset - 20,
      });
    });

    cursorY += infoBoxH + 20;

    // ── Earnings & Deductions Tables ────────────
    let earningsRows: { label: string; amount: number }[] = [];

    if (member.ctcAmount && member.componentTemplateId && data.componentTemplate) {
      const { breakdown } = calculateComponents(
        member.ctcAmount,
        data.componentTemplate.components,
        member.componentOverrides || [],
      );
      earningsRows = breakdown
        .filter((c) => c.includedInCtc)
        .map((c) => ({ label: c.name, amount: c.calculatedAmount }));

      const aboveCtc = breakdown.filter((c) => !c.includedInCtc);
      for (const c of aboveCtc) {
        earningsRows.push({
          label: `${c.name} (Employer)`,
          amount: c.calculatedAmount,
        });
      }
    } else {
      earningsRows = [{ label: 'Base Pay', amount: data.record.baseSalary || 0 }];
    }

    // Phase 23 (D-09): piece-rate earnings as separate line item
    const pieceRateEarnings = (data.record as any).pieceRateEarnings || 0;
    if (pieceRateEarnings > 0) {
      earningsRows.push({
        label: 'Piece Rate Earnings',
        amount: pieceRateEarnings,
      });
    }

    additions.forEach((adj) => {
      earningsRows.push({
        label: adj.reasonTitle || formatCategory(adj.category),
        amount: adj.amount,
      });
    });

    const deductionRows = deductions.map((adj) => ({
      label: adj.reasonTitle || formatCategory(adj.category),
      amount: adj.amount,
    }));

    const totalEarnings = earningsRows.reduce((sum, r) => sum + r.amount, 0);
    const totalDeductions = deductionRows.reduce((sum, r) => sum + r.amount, 0);

    // Build table rows
    const earningsTableRows: TableRow[] = earningsRows.map((r) => ({
      cells: [r.label, currencyFmt.full(r.amount)],
    }));
    earningsTableRows.push({
      cells: ['Total Earnings', currencyFmt.full(totalEarnings)],
      bold: true,
    });

    const deductionsTableRows: TableRow[] =
      deductionRows.length > 0
        ? [
            ...deductionRows.map((r) => ({
              cells: [r.label, currencyFmt.full(r.amount)],
            })),
            {
              cells: ['Total Deductions', currencyFmt.full(totalDeductions)],
              bold: true,
            },
          ]
        : [
            {
              cells: ['No deductions', currencyFmt.full(0)],
              muted: true,
            },
            {
              cells: ['Total Deductions', currencyFmt.full(0)],
              bold: true,
            },
          ];

    // Pad shorter table for visual balance
    while (earningsTableRows.length < deductionsTableRows.length) {
      earningsTableRows.splice(earningsTableRows.length - 1, 0, {
        cells: ['', ''],
      });
    }
    while (deductionsTableRows.length < earningsTableRows.length) {
      deductionsTableRows.splice(deductionsTableRows.length - 1, 0, {
        cells: ['', ''],
      });
    }

    const tableGap = 12;
    const singleTableWidth = (CONTENT_WIDTH - tableGap) / 2;
    const earningsColumns: TableColumn[] = [
      { width: singleTableWidth * 0.63, align: 'left' },
      { width: singleTableWidth * 0.37, align: 'right' },
    ];
    const deductionsColumns: TableColumn[] = [
      { width: singleTableWidth * 0.63, align: 'left' },
      { width: singleTableWidth * 0.37, align: 'right' },
    ];

    // Check page break before tables
    if (cursorY + 60 > CONTENT_BOTTOM) {
      doc.addPage();
      cursorY = 40;
    }

    const earningsEndY = drawTable(
      doc,
      MARGIN_X,
      cursorY,
      earningsColumns,
      ['EARNINGS', 'AMOUNT'],
      earningsTableRows,
      brandColor,
    );

    const deductionsEndY = drawTable(
      doc,
      MARGIN_X + singleTableWidth + tableGap,
      cursorY,
      deductionsColumns,
      ['DEDUCTIONS', 'AMOUNT'],
      deductionsTableRows,
      brandColor,
    );

    cursorY = Math.max(earningsEndY, deductionsEndY) + 24;

    // ── Net Pay Summary Box ─────────────────────
    const baseEarned = data.record.baseSalary || 0;
    const additionsTotal = additions.reduce((sum, a) => sum + a.amount, 0);
    const deductionsTotal = deductions.reduce((sum, a) => sum + a.amount, 0);
    const netPay = getNetPay(data.record, additionsTotal, deductionsTotal);
    const paidAmount = getPaidAmount(data.record, data.payments);
    const remainingAmount = Math.max(netPay - paidAmount, 0);

    const summaryH = 100;
    if (cursorY + summaryH > CONTENT_BOTTOM) {
      doc.addPage();
      cursorY = 40;
    }

    // Outer box
    doc
      .save()
      .roundedRect(MARGIN_X, cursorY, CONTENT_WIDTH, summaryH, 4)
      .strokeColor(rgbHex(brandColor))
      .lineWidth(1.2)
      .stroke()
      .restore();

    // Header band
    const bandH = 24;
    doc
      .save()
      .roundedRect(MARGIN_X, cursorY, CONTENT_WIDTH, bandH, 4)
      .fill(rgbHex(brandColor))
      .restore();
    // Cover bottom corners of band
    doc
      .save()
      .rect(MARGIN_X, cursorY + bandH - 4, CONTENT_WIDTH, 4)
      .fill(rgbHex(brandColor))
      .restore();

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#FFFFFF')
      .text('NET PAY SUMMARY', MARGIN_X + 10, cursorY + 7);

    const detailY = cursorY + bandH + 6;

    // Left: breakdown
    doc.font('Helvetica').fontSize(8.5).fillColor('#374151');
    doc.text(
      `Attendance Mode: ${getAttendanceModeLabel(data.record)} | Credited Days: ${data.record.presentDays || 0}/${data.record.totalDays || 0}`,
      MARGIN_X + 10,
      detailY,
    );
    doc.text(`Base Earned: ${currencyFmt.full(baseEarned)}`, MARGIN_X + 10, detailY + 16);
    doc.text(`+ Additions: ${currencyFmt.full(additionsTotal)}`, MARGIN_X + 10, detailY + 30);
    doc.text(`- Deductions: ${currencyFmt.full(deductionsTotal)}`, MARGIN_X + 10, detailY + 44);

    // Vertical divider
    const dividerX = PAGE_WIDTH / 2;
    doc
      .save()
      .moveTo(dividerX, detailY)
      .lineTo(dividerX, cursorY + summaryH - 10)
      .strokeColor('#DCDFE4')
      .lineWidth(0.7)
      .stroke()
      .restore();

    // Right: net pay
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(rgbHex(brandColor))
      .text('NET PAY', dividerX + 16, detailY + 6);

    doc.fontSize(18).text(currencyFmt.full(netPay), dividerX + 16, detailY + 22);

    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#374151')
      .text(
        `Paid: ${currencyFmt.full(paidAmount)} | Remaining: ${currencyFmt.full(remainingAmount)}`,
        dividerX + 16,
        detailY + 46,
      );

    cursorY += summaryH + 26;

    // ── Payment History Table ────────────────────
    if (activePayments.length > 0) {
      if (cursorY + 50 > CONTENT_BOTTOM) {
        doc.addPage();
        cursorY = 40;
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .fillColor('#3C3C3C')
        .text('PAYMENT HISTORY', MARGIN_X, cursorY);
      cursorY += 16;

      const paymentColumns: TableColumn[] = [
        { width: 80, align: 'left' }, // Date
        { width: 90, align: 'left' }, // Method
        { width: 90, align: 'right' }, // Amount
        { width: 140, align: 'left' }, // Reference
        { width: CONTENT_WIDTH - 400, align: 'center' }, // Status
      ];

      const paymentRows: TableRow[] = activePayments.map((p) => ({
        cells: [
          formatPaymentDate(p.paymentDate),
          titleCase(p.paymentMode || 'cash'),
          currencyFmt.full(p.amount + (p.commission || 0)),
          p.referenceNo || '—',
          titleCase(p.status || 'active'),
        ],
      }));

      cursorY = drawTable(
        doc,
        MARGIN_X,
        cursorY,
        paymentColumns,
        ['Date', 'Method', 'Amount', 'Reference', 'Status'],
        paymentRows,
        brandColor,
      );
    }

    // Phase 23 (D-09): Piece rate breakdown appendix
    const pieceBreakdown = (data.record as any).pieceRateBreakdown as
      | Array<{
          logId: any;
          downtimeCode: string;
          date: string;
          machineId: any;
          machineCode: string;
          metricLabel: string;
          qty: number;
          rate: number;
          amount: number;
        }>
      | undefined;
    if (pieceBreakdown && pieceBreakdown.length > 0) {
      doc.addPage();
      cursorY = 40;
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(rgbHex(COLOR_DARK))
        .text('Piece Rate Detail', MARGIN_X, cursorY);
      cursorY += 20;

      const breakdownColumns: TableColumn[] = [
        { width: CONTENT_WIDTH * 0.13, align: 'left' },
        { width: CONTENT_WIDTH * 0.13, align: 'left' },
        { width: CONTENT_WIDTH * 0.18, align: 'left' },
        { width: CONTENT_WIDTH * 0.16, align: 'left' },
        { width: CONTENT_WIDTH * 0.13, align: 'right' },
        { width: CONTENT_WIDTH * 0.12, align: 'right' },
        { width: CONTENT_WIDTH * 0.15, align: 'right' },
      ];
      const breakdownRows: TableRow[] = pieceBreakdown.map((b) => ({
        cells: [
          b.date,
          b.downtimeCode,
          b.machineCode,
          b.metricLabel,
          String(b.qty),
          currencyFmt.full(b.rate),
          currencyFmt.full(b.amount),
        ],
      }));
      const total = pieceBreakdown.reduce((s, b) => s + b.amount, 0);
      breakdownRows.push({
        cells: ['', '', '', '', '', 'Total', currencyFmt.full(total)],
        bold: true,
      });

      cursorY = drawTable(
        doc,
        MARGIN_X,
        cursorY,
        breakdownColumns,
        ['DATE', 'LOG', 'MACHINE', 'METRIC', 'QTY', 'RATE', 'AMOUNT'],
        breakdownRows,
        brandColor,
      );
    }

    // ── Advance Outstanding Note (informational only) ─────────────────────
    // Rendered after all tables. Does NOT affect net salary.
    if (data.advanceOutstanding && data.advanceOutstanding > 0) {
      cursorY += 14;
      if (cursorY + 20 > CONTENT_BOTTOM) {
        doc.addPage();
        cursorY = 40;
      }
      const finalY = cursorY;

      const noteLabel = `Advance outstanding (as of this payslip): ${currencyFmt.full(data.advanceOutstanding)}`;
      const NOTE_BG: [number, number, number] = [239, 246, 255]; // blue-50
      const NOTE_BORDER: [number, number, number] = [147, 197, 253]; // blue-300
      const NOTE_TEXT: [number, number, number] = [29, 78, 216]; // blue-700
      const noteH = 18;

      doc
        .save()
        .roundedRect(MARGIN_X, finalY, CONTENT_WIDTH, noteH, 3)
        .fillAndStroke(rgbHex(NOTE_BG), rgbHex(NOTE_BORDER))
        .restore();

      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(rgbHex(NOTE_TEXT))
        .text(noteLabel, MARGIN_X + 8, finalY + 5, {
          width: CONTENT_WIDTH - 16,
          align: 'left',
        });

      cursorY += noteH;
    }

    // ── Loan Outstanding Note (informational only) ────────────────────────
    // Rendered after all tables. Does NOT affect net salary.
    if (data.loanOutstanding && data.loanOutstanding > 0) {
      cursorY += 6;
      if (cursorY + 20 > CONTENT_BOTTOM) {
        doc.addPage();
        cursorY = 40;
      }
      const loanNoteY = cursorY;

      const loanNoteLabel = `Loan outstanding (as of this payslip): ${currencyFmt.full(data.loanOutstanding)}`;
      const LOAN_NOTE_BG: [number, number, number] = [240, 253, 244]; // green-50
      const LOAN_NOTE_BORDER: [number, number, number] = [134, 239, 172]; // green-300
      const LOAN_NOTE_TEXT: [number, number, number] = [21, 128, 61]; // green-700
      const loanNoteH = 18;

      doc
        .save()
        .roundedRect(MARGIN_X, loanNoteY, CONTENT_WIDTH, loanNoteH, 3)
        .fillAndStroke(rgbHex(LOAN_NOTE_BG), rgbHex(LOAN_NOTE_BORDER))
        .restore();

      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(rgbHex(LOAN_NOTE_TEXT))
        .text(loanNoteLabel, MARGIN_X + 8, loanNoteY + 5, {
          width: CONTENT_WIDTH - 16,
          align: 'left',
        });
    }
  }
}
