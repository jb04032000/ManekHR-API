import PDFDocument from 'pdfkit';
import type { OtSummaryRow, StatutoryMeta } from '../types/statutory.types';
import {
  A4_LANDSCAPE, drawTableRow, checkPageBreak,
  formatDate, formatCurrency, formatMinutesAsHours,
  type TableColumn,
} from './pdf-helpers';

/**
 * OT Register under Factories Act §59 (2× ordinary rate).
 * Labelled neutrally — "Form 25" is not the universally prescribed OT register
 * (Maharashtra Factories Rules 1963 Form 25 = disease notice).
 * Per G-RESEARCH.md finding #3 + pitfall #8, PDF header uses
 *   "OVERTIME REGISTER (Factories Act, 1948 §59)"
 *
 * Row granularity: one row per (member, day-with-OT). Rows are sorted by
 * member name, then date ascending. Members with zero OT rows are included
 * as a single "No OT" row for completeness (inspector visibility).
 *
 * Implementation note: PDFKit pushes data to its internal Readable buffer
 * synchronously during doc.end(). We read it synchronously via doc.read()
 * after end() returns, avoiding async stream event scheduling.
 */
export function generateForm25Ot(
  rows: OtSummaryRow[],
  meta: StatutoryMeta,
): Buffer {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: A4_LANDSCAPE.marginLeft });

  const columns: TableColumn[] = [
    { key: 'sr', label: 'Sr.', width: 28, align: 'center' },
    { key: 'name', label: 'Name', width: 130, align: 'left' },
    { key: 'code', label: 'Emp Code', width: 60, align: 'left' },
    { key: 'desig', label: 'Designation', width: 90, align: 'left' },
    { key: 'date', label: 'Date', width: 72, align: 'center' },
    { key: 'normal', label: 'Normal Hrs', width: 60, align: 'right' },
    { key: 'otHrs', label: 'OT Hrs', width: 50, align: 'right' },
    { key: 'rate', label: 'Daily Rate', width: 80, align: 'right' },
    { key: 'rateSrc', label: 'Rate Src', width: 60, align: 'center' },
    { key: 'amount', label: 'OT Wage (2x)', width: 96, align: 'right' },
  ];

  const drawHeader = (): number => {
    doc.fontSize(13).font('Helvetica-Bold').fillColor('black')
      .text('OVERTIME REGISTER', A4_LANDSCAPE.marginLeft, A4_LANDSCAPE.marginTop, {
        width: A4_LANDSCAPE.pageWidth - A4_LANDSCAPE.marginLeft - A4_LANDSCAPE.marginRight,
        align: 'center',
      });
    doc.fontSize(9).font('Helvetica')
      .text('(Factories Act, 1948 §59 — overtime payable at twice the ordinary rate of wages)', {
        width: A4_LANDSCAPE.pageWidth - A4_LANDSCAPE.marginLeft - A4_LANDSCAPE.marginRight,
        align: 'center',
      });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold').text(`Establishment: ${meta.workspaceName}`, { align: 'center' });
    if (meta.workspaceAddress) doc.fontSize(8).font('Helvetica').text(meta.workspaceAddress, { align: 'center' });
    doc.fontSize(9).text(`Period: ${formatDate(meta.from)}  to  ${formatDate(meta.to)}`, { align: 'center' });
    doc.moveDown(0.4);
    return drawTableRow(doc, columns, columns.map((c) => c.label),
      A4_LANDSCAPE.marginLeft, Math.max(doc.y, A4_LANDSCAPE.marginTop + 70), 20,
      { bold: true, fillColor: '#E5E7EB' });
  };

  let cursorY = drawHeader();
  const rowHeight = 18;

  // Flatten rows → one table row per (member, day) with index numbering
  let srIndex = 0;
  let grandTotalAmount = 0;
  let grandTotalMinutes = 0;

  if (rows.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#555')
      .text('(No members in scope)', A4_LANDSCAPE.marginLeft, cursorY + 10);
    doc.end();
    return readBufferSync(doc);
  }

  for (const member of rows) {
    if (member.days.length === 0) {
      srIndex += 1;
      cursorY = checkPageBreak(doc, cursorY, rowHeight, A4_LANDSCAPE, drawHeader);
      cursorY = drawTableRow(
        doc, columns,
        [String(srIndex), member.name, member.employeeCode ?? '-', member.designation ?? '-',
         '\u2014', '\u2014', '0:00', '\u2014', '\u2014', formatCurrency(0)],
        A4_LANDSCAPE.marginLeft, cursorY, rowHeight,
      );
      continue;
    }
    for (const d of member.days) {
      srIndex += 1;
      cursorY = checkPageBreak(doc, cursorY, rowHeight, A4_LANDSCAPE, drawHeader);
      const values = [
        String(srIndex),
        member.name,
        member.employeeCode ?? '-',
        member.designation ?? '-',
        formatDate(d.date),
        '8:00',                                          // standard workday
        formatMinutesAsHours(d.otMinutes),
        formatCurrency(d.dailyRate),
        d.rateSource.replace('_', ' '),
        formatCurrency(d.otAmount),
      ];
      cursorY = drawTableRow(doc, columns, values, A4_LANDSCAPE.marginLeft, cursorY, rowHeight);
      grandTotalAmount += d.otAmount;
      grandTotalMinutes += d.otMinutes;
    }
  }

  // GRAND TOTAL row
  cursorY = checkPageBreak(doc, cursorY, rowHeight, A4_LANDSCAPE, drawHeader);
  cursorY = drawTableRow(
    doc, columns,
    ['', 'GRAND TOTAL', '', '', '', '', formatMinutesAsHours(grandTotalMinutes), '', '', formatCurrency(grandTotalAmount)],
    A4_LANDSCAPE.marginLeft, cursorY, rowHeight,
    { bold: true, fillColor: '#F3F4F6' },
  );

  // Legal footer
  doc.fontSize(7).font('Helvetica').fillColor('#555')
    .text(
      `Generated: ${meta.generatedAt.toISOString()}${meta.generatedByName ? ' by ' + meta.generatedByName : ''} | ` +
        `OT wage = ordinary daily rate x 2 x OT hours / 8 (Factories Act §59).`,
      A4_LANDSCAPE.marginLeft,
      A4_LANDSCAPE.pageHeight - A4_LANDSCAPE.marginBottom + 10,
      { width: A4_LANDSCAPE.pageWidth - 2 * A4_LANDSCAPE.marginLeft },
    );

  doc.end();
  return readBufferSync(doc);
}

/**
 * Synchronously read all buffered chunks from a PDFDocument after doc.end().
 *
 * PDFKit extends node's Readable stream. When doc.end() is called it pushes all
 * remaining data synchronously into the stream's internal buffer via this.push().
 * Since we never attach a 'data' event listener (which would switch the stream
 * to flowing mode), the data stays in the internal buffer and can be read
 * synchronously with doc.read().
 */
function readBufferSync(doc: PDFKit.PDFDocument): Buffer {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while (null !== (chunk = doc.read() as Buffer | null)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
