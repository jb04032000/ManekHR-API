import PDFDocument from 'pdfkit';
import type { AttendanceSummaryRow, StatutoryMeta } from '../types/statutory.types';
import {
  A4_LANDSCAPE, drawTableRow, checkPageBreak,
  formatDate, statusToGlyph, enumerateDates,
  type TableColumn,
} from './pdf-helpers';

/**
 * GJ Form D — Register of Attendance
 * Gujarat Shops and Establishments (Regulation of Employment and
 * Conditions of Service) Act, 2019, Rule 26 read with Form D.
 *
 * Layout mirrors MH Form T: per-day glyph grid for ≤ 14 days,
 * summary table for longer ranges (landscape A4 constraint).
 *
 * Columns (per Gujarat S&E Act 2019 Form D schedule):
 *   Sr. No | Name | Emp Code | Designation | Date of Joining |
 *   [day columns] | Present | Absent | OT (hrs)
 */
export function generateGjFormD(
  rows: AttendanceSummaryRow[],
  meta: StatutoryMeta,
): Buffer {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: A4_LANDSCAPE.marginLeft });

  const days = enumerateDates(meta.from, meta.to);
  const perDayGrid = days.length <= 14;

  const buildColumns = (): TableColumn[] => {
    const base: TableColumn[] = [
      { key: 'sr',    label: 'Sr.',         width: 24,  align: 'center' },
      { key: 'name',  label: 'Name',         width: 120, align: 'left' },
      { key: 'code',  label: 'Emp Code',     width: 58,  align: 'left' },
      { key: 'desig', label: 'Designation',  width: 85,  align: 'left' },
      { key: 'doj',   label: 'Date of Join', width: 68,  align: 'center' },
    ];

    if (perDayGrid) {
      const reserved = base.reduce((s, c) => s + c.width, 0) + 55 + 55 + 58; // present+absent+ot
      const remaining = (A4_LANDSCAPE.pageWidth - 2 * A4_LANDSCAPE.marginLeft) - reserved;
      const per = Math.max(14, Math.floor(remaining / days.length));
      for (const iso of days) {
        const dayNum = Number(iso.slice(8, 10));
        base.push({ key: iso, label: String(dayNum), width: per, align: 'center' });
      }
    }

    base.push(
      { key: 'present', label: 'Present', width: 55, align: 'center' },
      { key: 'absent',  label: 'Absent',  width: 55, align: 'center' },
      { key: 'ot',      label: 'OT (hrs)', width: 58, align: 'right' },
    );
    return base;
  };

  const columns = buildColumns();

  const drawColumnHeaders = (y: number): number =>
    drawTableRow(
      doc, columns, columns.map((c) => c.label),
      A4_LANDSCAPE.marginLeft, y, 20,
      { bold: true, fillColor: '#DBEAFE' },
    );

  const drawHeader = (): number => {
    doc.fontSize(13).font('Helvetica-Bold').fillColor('black')
      .text('REGISTER OF ATTENDANCE', A4_LANDSCAPE.marginLeft, A4_LANDSCAPE.marginTop, {
        width: A4_LANDSCAPE.pageWidth - A4_LANDSCAPE.marginLeft - A4_LANDSCAPE.marginRight,
        align: 'center',
      });
    doc.fontSize(9).font('Helvetica')
      .text('(Form D — Gujarat Shops and Establishments Act, 2019, Rule 26)', {
        width: A4_LANDSCAPE.pageWidth - A4_LANDSCAPE.marginLeft - A4_LANDSCAPE.marginRight,
        align: 'center',
      });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold')
      .text(`Establishment: ${meta.workspaceName}`, { align: 'center' });
    if (meta.workspaceAddress) {
      doc.fontSize(8).font('Helvetica').text(meta.workspaceAddress, { align: 'center' });
    }
    doc.fontSize(9).text(`Period: ${formatDate(meta.from)}  to  ${formatDate(meta.to)}`, { align: 'center' });
    doc.moveDown(0.4);
    return drawColumnHeaders(Math.max(doc.y, A4_LANDSCAPE.marginTop + 70));
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

    const doj = row.days.length > 0
      ? formatDate(row.days.reduce((min, d) => (d.date < min ? d.date : min), row.days[0].date))
      : '-';

    const values: string[] = [
      String(idx + 1),
      row.name,
      row.employeeCode ?? '-',
      row.designation ?? '-',
      doj,
    ];

    if (perDayGrid) {
      const byDate = new Map(row.days.map((d) => [d.date, d]));
      for (const iso of days) {
        const day = byDate.get(iso);
        values.push(day ? statusToGlyph(day.status) : '-');
      }
    }

    values.push(
      String(row.totalPresentDays),
      String(row.totalAbsentDays),
      (row.totalOtMinutes / 60).toFixed(1),
    );

    cursorY = drawTableRow(doc, columns, values, A4_LANDSCAPE.marginLeft, cursorY, rowHeight);
  });

  // Signature block
  const sigY = Math.min(cursorY + 30, A4_LANDSCAPE.pageHeight - A4_LANDSCAPE.marginBottom - 30);
  doc.fontSize(8).font('Helvetica').fillColor('#333')
    .text('Signature of Employer / Manager: ____________________________', A4_LANDSCAPE.marginLeft, sigY);

  // Footer
  doc.fontSize(7).fillColor('#555')
    .text(
      `Generated: ${meta.generatedAt.toISOString()}${meta.generatedByName ? ' by ' + meta.generatedByName : ''}`,
      A4_LANDSCAPE.marginLeft,
      A4_LANDSCAPE.pageHeight - A4_LANDSCAPE.marginBottom + 10,
    );

  doc.end();
  return readBufferSync(doc);
}

function readBufferSync(doc: PDFKit.PDFDocument): Buffer {
  const chunks: Buffer[] = [];
  let chunk: Buffer | null;
  while (null !== (chunk = doc.read() as Buffer | null)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
