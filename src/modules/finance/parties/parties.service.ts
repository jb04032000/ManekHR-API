import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trace } from '@opentelemetry/api';
import { Model, Types } from 'mongoose';
import { Party } from './party.schema';
import { withFinanceSpan } from '../common/finance-observability';

@Injectable()
export class PartiesService {
  // Platform-bar observability: shared finance tracer (mirrors QuotationService).
  // Spans wrap each write. PostHog events are intentionally NOT emitted here -
  // none of these write methods receive a `userId` (the controller does not
  // thread it), and the polish rule forbids changing the method signatures.
  private readonly tracer = trace.getTracer('finance');

  constructor(@InjectModel(Party.name) private readonly model: Model<Party>) {}

  async create(workspaceId: string, firmId: string, dto: any): Promise<Party> {
    return withFinanceSpan(
      this.tracer,
      'finance.createParty',
      { workspaceId, firmId },
      async () => {
        const doc = new this.model({
          ...dto,
          workspaceId: new Types.ObjectId(workspaceId),
          firmId: new Types.ObjectId(firmId),
        });
        return doc.save();
      },
    );
  }

  async findAll(
    workspaceId: string,
    firmId: string,
    query: any = {},
  ): Promise<{ items: Party[]; total: number }> {
    const filter: any = {
      workspaceId: new Types.ObjectId(workspaceId),
      firmId: new Types.ObjectId(firmId),
      isDeleted: false,
    };
    if (query.partyType) filter.partyType = query.partyType;
    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ name: 1 }).exec(),
      this.model.countDocuments(filter).exec(),
    ]);
    return { items, total };
  }

  async findOne(workspaceId: string, firmId: string, partyId: string): Promise<Party> {
    const doc = await this.model
      .findOne({
        _id: new Types.ObjectId(partyId),
        workspaceId: new Types.ObjectId(workspaceId),
        firmId: new Types.ObjectId(firmId),
        isDeleted: false,
      })
      .exec();
    if (!doc) throw new NotFoundException('Party not found');
    return doc;
  }

  async update(workspaceId: string, firmId: string, partyId: string, dto: any): Promise<Party> {
    return withFinanceSpan(
      this.tracer,
      'finance.updateParty',
      { workspaceId, firmId, partyId },
      async () => {
        const doc = await this.model
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(partyId),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            },
            { $set: dto },
            { new: true },
          )
          .exec();
        if (!doc) throw new NotFoundException('Party not found');
        return doc;
      },
    );
  }

  /**
   * Phase 17 / FIN-16-05 D-32 — toggle the per-contact suppressGreetings flag.
   *
   * Uses positional `$set` on the contacts subdoc array so we never re-write
   * the entire `contacts[]` array (avoids losing concurrent edits to other
   * contacts). Throws 404 if the (workspaceId, firmId, partyId, contactId)
   * tuple does not match an existing non-deleted party.
   *
   * Pitfall 1 (Mongoose 8.23 autocast): every ObjectId wrapped via
   * `new Types.ObjectId(...)`.
   */
  async updateContactSuppressGreetings(
    workspaceId: string,
    firmId: string,
    partyId: string,
    contactId: string,
    suppress: boolean,
  ): Promise<Party> {
    return withFinanceSpan(
      this.tracer,
      'finance.updatePartyContactSuppressGreetings',
      { workspaceId, firmId, partyId, contactId, suppress },
      async () => {
        const wsOid = new Types.ObjectId(workspaceId);
        const firmOid = new Types.ObjectId(firmId);
        const partyOid = new Types.ObjectId(partyId);
        const contactOid = new Types.ObjectId(contactId);

        const result = await this.model
          .updateOne(
            {
              _id: partyOid,
              workspaceId: wsOid,
              firmId: firmOid,
              isDeleted: false,
              'contacts._id': contactOid,
            },
            { $set: { 'contacts.$.suppressGreetings': suppress } },
          )
          .exec();

        if (result.matchedCount === 0) {
          throw new NotFoundException('Party or contact not found');
        }

        const updated = await this.model
          .findOne({
            _id: partyOid,
            workspaceId: wsOid,
            firmId: firmOid,
            isDeleted: false,
          })
          .lean()
          .exec();
        if (!updated) throw new NotFoundException('Party not found after update');
        return updated as unknown as Party;
      },
    );
  }

  async remove(workspaceId: string, firmId: string, partyId: string): Promise<void> {
    return withFinanceSpan(
      this.tracer,
      'finance.removeParty',
      { workspaceId, firmId, partyId },
      async () => {
        const result = await this.model
          .updateOne(
            {
              _id: new Types.ObjectId(partyId),
              workspaceId: new Types.ObjectId(workspaceId),
              firmId: new Types.ObjectId(firmId),
              isDeleted: false,
            },
            { isDeleted: true, deletedAt: new Date() },
          )
          .exec();
        if (result.matchedCount === 0) throw new NotFoundException('Party not found');
      },
    );
  }
}
