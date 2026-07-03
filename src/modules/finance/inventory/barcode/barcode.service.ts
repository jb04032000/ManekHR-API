import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bwipjs from 'bwip-js';
// D-09 LOCKED: jsPDF for server-side PDF generation (NOT pdfkit).
// Project policy (CLAUDE.md): jsPDF + jspdf-autotable is the standard PDF library.
// jsPDF v4+ supports Node.js natively without DOM.
// bwip-js PNG buffers embedded via doc.addImage(buffer, 'PNG', x, y, w, h).
import { jsPDF } from 'jspdf';
import { Item } from '../../items/item.schema';
import { Lot, LotDocument } from '../lots/lot.schema';

export type LabelSize = '20x10' | '30x20' | '38x25' | '50x30' | 'a4_sheet';

const LABEL_DIMENSIONS_MM: Record<Exclude<LabelSize, 'a4_sheet'>, { w: number; h: number }> = {
  '20x10': { w: 20, h: 10 },
  '30x20': { w: 30, h: 20 },
  '38x25': { w: 38, h: 25 },
  '50x30': { w: 50, h: 30 },
};

const MM_TO_PT = 2.834645669;

@Injectable()
export class BarcodeService {
  private readonly logger = new Logger(BarcodeService.name);

  constructor(
    @InjectModel(Item.name) private readonly itemModel: Model<Item>,
    @InjectModel(Lot.name) private readonly lotModel: Model<LotDocument>,
  ) {}

  async generateLabelPdf(
    workspaceId: string,
    firmId: string,
    itemId: string,
    opts: {
      labelSize: LabelSize;
      lotId?: string;
      batchId?: string;
      copies?: number;
    },
  ): Promise<Buffer> {
    const item = await this.itemModel
      .findOne({
        _id: new Types.ObjectId(itemId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
      .lean();
    if (!item) throw new NotFoundException('Item not found');

    const lot =
      opts.lotId
        ? await this.lotModel
            .findOne({
              _id: new Types.ObjectId(opts.lotId),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
            })
            .lean()
        : null;

    const itemCode = (item as any).itemCode || item._id.toString();
    const copies = Math.max(1, Math.min(500, opts.copies ?? 1));

    const barcodePng = await (bwipjs as any).toBuffer({
      bcid: 'code128',
      text: itemCode,
      scale: 3,
      height: 8,
      includetext: false,
    });

    const qrData = JSON.stringify({
      i: itemCode,
      n: (item as any).name,
      l: (lot as any)?.lotNo,
      e: (lot as any)?.expiryDate,
    });
    const qrPng = await (bwipjs as any).toBuffer({ bcid: 'qrcode', text: qrData, scale: 4 });

    if (opts.labelSize === 'a4_sheet') {
      return this.buildA4Sheet(item, lot, barcodePng, qrPng, copies);
    }
    return this.buildSingleSize(item, lot, barcodePng, qrPng, copies, opts.labelSize);
  }

  private buildSingleSize(
    item: any,
    lot: any,
    barcodePng: Buffer,
    qrPng: Buffer,
    copies: number,
    size: Exclude<LabelSize, 'a4_sheet'>,
  ): Buffer {
    const dims = LABEL_DIMENSIONS_MM[size];
    const w = dims.w * MM_TO_PT;
    const h = dims.h * MM_TO_PT;
    const doc = new jsPDF({
      unit: 'pt',
      format: [w, h],
      orientation: w > h ? 'landscape' : 'portrait',
    });

    for (let i = 0; i < copies; i++) {
      if (i > 0) doc.addPage([w, h], w > h ? 'landscape' : 'portrait');
      doc.setFont('Helvetica', 'bold').setFontSize(10);
      doc.text(item.name ?? '', 4, 12, { maxWidth: w - 8 });
      doc.setFont('Helvetica', 'normal').setFontSize(8);
      let y = 22;
      doc.text(`Code: ${item.itemCode ?? ''}`, 4, y);
      if (lot?.lotNo) {
        y += 9;
        doc.text(`Lot: ${lot.lotNo}`, 4, y);
      }
      if (lot?.expiryDate) {
        y += 9;
        const days = Math.floor(
          (new Date(lot.expiryDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
        );
        if (days < 30) {
          doc.setTextColor(220, 38, 38);
        } else {
          doc.setTextColor(0, 0, 0);
        }
        doc.text(`Exp: ${new Date(lot.expiryDate).toISOString().slice(0, 10)}`, 4, y);
        doc.setTextColor(0, 0, 0);
      }
      // bwip-js PNG buffer embedded directly into jsPDF via addImage (Node-compatible)
      doc.addImage(barcodePng, 'PNG', 4, h - 22, w * 0.65, 18);
      doc.addImage(qrPng, 'PNG', w - 26, 4, 22, 22);
    }

    // jsPDF in Node: output('arraybuffer') -> Buffer.from()
    const ab = doc.output('arraybuffer');
    return Buffer.from(ab);
  }

  private buildA4Sheet(
    item: any,
    lot: any,
    barcodePng: Buffer,
    qrPng: Buffer,
    copies: number,
  ): Buffer {
    // 24 labels per A4: 3 cols x 8 rows (Avery L7159 layout: 63.5x33.9mm per cell)
    const cellW = 63.5 * MM_TO_PT;
    const cellH = 33.9 * MM_TO_PT;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' });
    const cols = 3;
    const rows = 8;
    const perPage = cols * rows;

    for (let i = 0; i < copies; i++) {
      if (i > 0 && i % perPage === 0) doc.addPage('a4', 'portrait');
      const idx = i % perPage;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = col * cellW;
      const y = row * cellH;
      doc.setFont('Helvetica', 'bold').setFontSize(9);
      doc.text(item.name ?? '', x + 4, y + 12, { maxWidth: cellW - 8 });
      doc.setFont('Helvetica', 'normal').setFontSize(7);
      doc.text(`Code: ${item.itemCode ?? ''}`, x + 4, y + 22);
      if (lot?.lotNo) doc.text(`Lot: ${lot.lotNo}`, x + 4, y + 30);
      doc.addImage(barcodePng, 'PNG', x + 4, y + cellH - 18, cellW * 0.65, 14);
      doc.addImage(qrPng, 'PNG', x + cellW - 22, y + 4, 18, 18);
    }

    const ab = doc.output('arraybuffer');
    return Buffer.from(ab);
  }
}
