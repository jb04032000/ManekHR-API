import type PDFDocument from 'pdfkit';

export interface PageGeometry {
  marginLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  pageWidth: number;    // A4 landscape = 842
  pageHeight: number;   // A4 landscape = 595
}

export const A4_LANDSCAPE: PageGeometry = {
  marginLeft: 40, marginTop: 40, marginRight: 40, marginBottom: 40,
  pageWidth: 842, pageHeight: 595,
};

export const A4_PORTRAIT: PageGeometry = {
  marginLeft: 40, marginTop: 40, marginRight: 40, marginBottom: 40,
  pageWidth: 595, pageHeight: 842,
};

export interface TableColumn {
  key: string;
  label: string;
  width: number;          // in pts
  align?: 'left' | 'right' | 'center';
}

/**
 * Draw a single row (header or data). Returns the new cursorY after the row.
 * Caller is responsible for page-break checks via checkPageBreak().
 */
export function drawTableRow(
  doc: PDFKit.PDFDocument,
  columns: TableColumn[],
  values: string[],
  startX: number,
  cursorY: number,
  rowHeight: number,
  options: { bold?: boolean; fillColor?: string } = {},
): number {
  if (options.fillColor) {
    let x = startX;
    for (const col of columns) {
      doc.save().rect(x, cursorY, col.width, rowHeight).fill(options.fillColor).restore();
      x += col.width;
    }
  }
  // Borders
  let x = startX;
  for (const col of columns) {
    doc.rect(x, cursorY, col.width, rowHeight).stroke();
    x += col.width;
  }
  // Text
  x = startX;
  doc.fontSize(8).font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('black');
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const value = values[i] ?? '';
    doc.text(value, x + 3, cursorY + 4, {
      width: col.width - 6,
      align: col.align ?? 'left',
      lineBreak: false,
      ellipsis: true,
    });
    x += col.width;
  }
  return cursorY + rowHeight;
}

/**
 * If next row would overflow the page, start a new page and redraw the header.
 * Returns cursorY: unchanged if no break, or the post-header cursorY on new page.
 */
export function checkPageBreak(
  doc: PDFKit.PDFDocument,
  cursorY: number,
  rowHeight: number,
  geom: PageGeometry,
  redrawHeader: () => number,    // callback returns new cursorY after drawing header
): number {
  if (cursorY + rowHeight > geom.pageHeight - geom.marginBottom) {
    doc.addPage();
    return redrawHeader();
  }
  return cursorY;
}

/** Format YYYY-MM-DD to DD-MMM-YYYY for legal doc display. */
export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getUTCDate()).padStart(2,'0')}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** Format raw minutes as "H:MM" (e.g. 125 → "2:05"). Used for OT hours display. */
export function formatMinutesAsHours(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Single-char glyph per attendance status (Form Q conventions). */
export function statusToGlyph(status: string): string {
  switch (status) {
    case 'present':  return 'P';
    case 'absent':   return 'A';
    case 'half_day': return '½';
    case 'late':     return 'L';
    case 'on_leave': return 'OL';
    case 'holiday':  return 'Ho';
    case 'week_off': return 'W';
    default:         return '-';
  }
}

/** Format Rs. amounts with comma grouping (Indian numbering for statutory docs). */
export function formatCurrency(amount: number): string {
  return `Rs.${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Enumerate ISO dates from `from` to `to` inclusive. */
export function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`);
  }
  return out;
}
