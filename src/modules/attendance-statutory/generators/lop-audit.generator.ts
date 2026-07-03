import PDFDocument from 'pdfkit';
import type { LopSummaryRow, StatutoryMeta } from '../types/statutory.types';
import {
  A4_LANDSCAPE, drawTableRow, checkPageBreak,
  formatDate, formatCurrency,
  type TableColumn,
} from './pdf-helpers';

/**
 * LOP Audit Trail PDF per DG-4:
 * One section per member containing:
 *   - Member header (name, emp code, designation, baseSalary)
 *   - Per-day rows where lopMinutes > 0 (date, status, shiftDur mins, worked mins, lop mins, computeReason)
 *   - Summary footer (total LOP days, total LOP minutes, deduction amount or '-' when baseSalary null)
 *
 * No prescribed statutory form — this is an internal audit trail (G-RESEARCH §LOP Audit Trail).
 *
 * Implementation note: PDFKit pushes data to its internal Readable buffer
 * synchronously during doc.end(). We read it synchronously via doc.read()
 * after end() returns, avoiding async stream event scheduling.
 */
export function generateLopAudit(
  rows: LopSummaryRow[],
  meta: StatutoryMeta,
): Buffer {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: A4_LANDSCAPE.marginLeft });

  const columns: TableColumn[] = [
    { key: 'date', label: 'Date', width: 72, align: 'center' },
    { key: 'status', label: 'Status', width: 60, align: 'center' },
    { key: 'shiftDur', label: 'Shift Min', width: 60, align: 'right' },
    { key: 'worked', label: 'Worked Min', width: 70, align: 'right' },
    { key: 'lop', label: 'LOP Min', width: 60, align: 'right' },
    { key: 'reason', label: 'Compute Reason', width: 440, align: 'left' },
  ];

  const drawTopHeader = (): number => {
    doc.fontSize(13).font('Helvetica-Bold')
      .text('LOSS OF PAY (LOP) AUDIT TRAIL', A4_LANDSCAPE.marginLeft, A4_LANDSCAPE.marginTop, {
        width: A4_LANDSCAPE.pageWidth - 2 * A4_LANDSCAPE.marginLeft, align: 'center',
      });
    doc.fontSize(9).font('Helvetica')
      .text('(Internal document — for payroll transparency and employee grievance resolution)', {
        width: A4_LANDSCAPE.pageWidth - 2 * A4_LANDSCAPE.marginLeft, align: 'center',
      });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold').text(`Establishment: ${meta.workspaceName}`, { align: 'center' });
    if (meta.workspaceAddress) doc.fontSize(8).font('Helvetica').text(meta.workspaceAddress, { align: 'center' });
    doc.fontSize(9).text(`Period: ${formatDate(meta.from)}  to  ${formatDate(meta.to)}`, { align: 'center' });
    doc.moveDown(0.5);
    return doc.y;
  };

  const drawTableHeaderRow = (y: number): number => drawTableRow(
    doc, columns, columns.map((c) => c.label),
    A4_LANDSCAPE.marginLeft, y, 18,
    { bold: true, fillColor: '#E5E7EB' },
  );

  let cursorY = drawTopHeader();

  if (rows.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#555')
      .text('(No members in scope)', A4_LANDSCAPE.marginLeft, cursorY + 10);
    doc.end();
    return readBufferSync(doc);
  }

  const rowHeight = 16;
  const redrawSectionHeader = (): number => {
    // on new page, restate the top header then table header
    const y0 = drawTopHeader();
    return drawTableHeaderRow(y0);
  };

  for (const member of rows) {
    // Member block header
    cursorY = checkPageBreak(doc, cursorY, 50, A4_LANDSCAPE, redrawSectionHeader);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('black')
      .text(
        `${member.name}  (${member.employeeCode ?? '—'})  ${member.designation ? '— ' + member.designation : ''}`,
        A4_LANDSCAPE.marginLeft, cursorY,
      );
    cursorY += 16;
    doc.fontSize(8).font('Helvetica').fillColor('#555').text(
      `Base Salary: ${member.baseSalary !== null ? formatCurrency(member.baseSalary) : '— (no salary generated for reference month)'}`,
      A4_LANDSCAPE.marginLeft, cursorY,
    );
    cursorY += 14;

    if (member.days.length === 0) {
      doc.fontSize(9).font('Helvetica-Oblique').fillColor('#777')
        .text('(No LOP days in range)', A4_LANDSCAPE.marginLeft + 20, cursorY);
      cursorY += 20;
      continue;
    }

    // Table header
    cursorY = drawTableHeaderRow(cursorY);
    // Data rows
    for (const day of member.days) {
      cursorY = checkPageBreak(doc, cursorY, rowHeight, A4_LANDSCAPE, redrawSectionHeader);
      cursorY = drawTableRow(
        doc, columns,
        [
          formatDate(day.date),
          day.status,
          String(day.shiftDurationMinutes),
          day.workedMinutes === null ? '—' : String(day.workedMinutes),
          String(day.lopMinutes),
          day.computeReason ?? '',
        ],
        A4_LANDSCAPE.marginLeft, cursorY, rowHeight,
      );
    }

    // Summary row
    cursorY = checkPageBreak(doc, cursorY, rowHeight, A4_LANDSCAPE, redrawSectionHeader);
    cursorY = drawTableRow(
      doc, columns,
      [
        'TOTAL',
        `${member.totalLopDays} days`,
        '',
        '',
        String(member.totalLopMinutes),
        member.deductionAmount !== null
          ? `Deduction: ${formatCurrency(member.deductionAmount)}`
          : 'Deduction: — (no salary ref)',
      ],
      A4_LANDSCAPE.marginLeft, cursorY, rowHeight,
      { bold: true, fillColor: '#F3F4F6' },
    );
    cursorY += 10; // gap between members
  }

  // Footer
  doc.fontSize(7).font('Helvetica').fillColor('#555').text(
    `Generated: ${meta.generatedAt.toISOString()}${meta.generatedByName ? ' by ' + meta.generatedByName : ''}. ` +
      'LOP formula: lopMinutes = max(0, shiftDurationMinutes - workedMinutes). ' +
      'Deduction = baseSalary x totalLopMinutes / (totalDays x 480).',
    A4_LANDSCAPE.marginLeft,
    A4_LANDSCAPE.pageHeight - A4_LANDSCAPE.marginBottom + 8,
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
