import PDFDocument from 'pdfkit';
import type { AttendanceSummaryRow, StatutoryMeta } from '../types/statutory.types';
import {
  A4_LANDSCAPE, drawTableRow, checkPageBreak,
  formatDate, statusToGlyph, enumerateDates,
  type TableColumn,
} from './pdf-helpers';

/**
 * MH "Form T" muster roll — implemented as Form Q layout per
 * Maharashtra S&E Act 2017 (G-RESEARCH.md finding #3).
 * PDF header uses accurate statutory language to avoid misrepresentation.
 *
 * Columns (per G-RESEARCH §Statutory Form Layout):
 *   Sr. No, Name, Emp Code, Designation, (one column per day with glyph),
 *   Total Present Days, OT Hours
 *
 * For date ranges > 14 days we fall back to a summary table (no per-day grid)
 * to keep the PDF readable on landscape A4.
 *
 * Implementation note: PDFKit pushes data to its internal Readable buffer
 * synchronously during doc.end(). We read it synchronously via doc.read()
 * after end() returns, avoiding async stream event scheduling.
 */
export function generateMhFormT(
  rows: AttendanceSummaryRow[],
  meta: StatutoryMeta,
): Buffer {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: A4_LANDSCAPE.marginLeft });

  const days = enumerateDates(meta.from, meta.to);
  const perDayGrid = days.length <= 14;          // only fits when ≤ 14 days

  const buildColumns = (): TableColumn[] => {
    const base: TableColumn[] = [
      { key: 'sr', label: 'Sr.', width: 24, align: 'center' },
      { key: 'name', label: 'Name', width: 130, align: 'left' },
      { key: 'code', label: 'Emp Code', width: 60, align: 'left' },
      { key: 'desig', label: 'Designation', width: 90, align: 'left' },
    ];
    if (perDayGrid) {
      const remainingWidth = (A4_LANDSCAPE.pageWidth - 2 * A4_LANDSCAPE.marginLeft)
        - base.reduce((s, c) => s + c.width, 0) - 70;           // reserve 70 for total
      const per = Math.max(14, Math.floor(remainingWidth / days.length));
      for (const iso of days) {
        const dayNum = Number(iso.slice(8, 10));
        base.push({ key: iso, label: String(dayNum), width: per, align: 'center' });
      }
      base.push({ key: 'total', label: 'Present', width: 70, align: 'center' });
    } else {
      base.push(
        { key: 'present', label: 'Present', width: 60, align: 'right' },
        { key: 'absent', label: 'Absent', width: 60, align: 'right' },
        { key: 'late', label: 'Late', width: 50, align: 'right' },
        { key: 'half', label: 'Half', width: 50, align: 'right' },
        { key: 'ot', label: 'OT (hrs)', width: 70, align: 'right' },
      );
    }
    return base;
  };

  const columns = buildColumns();

  const drawColumnHeaders = (): number => {
    const cursorY = Math.max(doc.y, A4_LANDSCAPE.marginTop + 70);
    return drawTableRow(
      doc, columns, columns.map((c) => c.label),
      A4_LANDSCAPE.marginLeft, cursorY, 20,
      { bold: true, fillColor: '#E5E7EB' },
    );
  };

  const drawHeader = (): number => {
    // Legal title — neutral statutory language (research finding #8)
    doc.fontSize(13).font('Helvetica-Bold').fillColor('black')
      .text('MUSTER ROLL CUM WAGES REGISTER', A4_LANDSCAPE.marginLeft, A4_LANDSCAPE.marginTop, {
        width: A4_LANDSCAPE.pageWidth - A4_LANDSCAPE.marginLeft - A4_LANDSCAPE.marginRight,
        align: 'center',
      });
    doc.fontSize(9).font('Helvetica')
      .text('(Form Q equivalent — Maharashtra Shops & Establishments Act 2017)', {
        width: A4_LANDSCAPE.pageWidth - A4_LANDSCAPE.marginLeft - A4_LANDSCAPE.marginRight,
        align: 'center',
      });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold').text(`Establishment: ${meta.workspaceName}`, { align: 'center' });
    if (meta.workspaceAddress) doc.fontSize(8).font('Helvetica').text(meta.workspaceAddress, { align: 'center' });
    doc.fontSize(9).text(`Period: ${formatDate(meta.from)}  to  ${formatDate(meta.to)}`, { align: 'center' });
    doc.moveDown(0.4);
    return drawColumnHeaders();
  };

  let cursorY = drawHeader();
  const rowHeight = 18;

  if (rows.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#555')
      .text('(No members in scope)', A4_LANDSCAPE.marginLeft, cursorY + 10);
    doc.end();
    return readBufferSync(doc);
  }

  rows.forEach((row, idx) => {
    cursorY = checkPageBreak(doc, cursorY, rowHeight, A4_LANDSCAPE, drawHeader);
    const values: string[] = [
      String(idx + 1),
      row.name,
      row.employeeCode ?? '-',
      row.designation ?? '-',
    ];
    if (perDayGrid) {
      const byDate = new Map(row.days.map((d) => [d.date, d]));
      for (const iso of days) {
        const day = byDate.get(iso);
        values.push(day ? statusToGlyph(day.status) : '-');
      }
      values.push(String(row.totalPresentDays));
    } else {
      values.push(
        String(row.totalPresentDays),
        String(row.totalAbsentDays),
        String(row.totalLateDays),
        String(row.totalHalfDays),
        (row.totalOtMinutes / 60).toFixed(1),
      );
    }
    cursorY = drawTableRow(doc, columns, values, A4_LANDSCAPE.marginLeft, cursorY, rowHeight);
  });

  // Footer
  doc.fontSize(7).font('Helvetica').fillColor('#555')
    .text(
      `Generated: ${meta.generatedAt.toISOString()}${meta.generatedByName ? ' by ' + meta.generatedByName : ''}`,
      A4_LANDSCAPE.marginLeft,
      A4_LANDSCAPE.pageHeight - A4_LANDSCAPE.marginBottom + 10,
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
