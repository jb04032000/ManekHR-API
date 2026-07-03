import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CessRule, CessRuleDocument } from './cess-rule.schema';
import { UpsertCessRuleDto } from './dto/upsert-cess-rule.dto';

@Injectable()
export class CessRulesService {
  constructor(
    @InjectModel(CessRule.name)
    private readonly model: Model<CessRuleDocument>,
  ) {}

  /** List all active CessRules ordered by HSN code */
  async list(): Promise<CessRuleDocument[]> {
    return this.model
      .find({ isActive: true })
      .sort({ hsnCode: 1 })
      .lean() as unknown as CessRuleDocument[];
  }

  /**
   * Idempotent upsert by hsnCode.
   * Used by the seed on module init and by admin API.
   */
  async upsert(dto: UpsertCessRuleDto): Promise<CessRuleDocument> {
    const updateDoc: Record<string, any> = {
      description: dto.description,
      cessType: dto.cessType,
      applicableFrom: new Date(dto.applicableFrom),
      isActive: dto.isActive ?? true,
    };
    if (dto.adValoremRate !== undefined) updateDoc.adValoremRate = dto.adValoremRate;
    if (dto.specificRatePerUnit !== undefined) updateDoc.specificRatePerUnit = dto.specificRatePerUnit;
    if (dto.specificRateUnit !== undefined) updateDoc.specificRateUnit = dto.specificRateUnit;
    if (dto.applicableTo !== undefined) updateDoc.applicableTo = new Date(dto.applicableTo);

    return this.model.findOneAndUpdate(
      { hsnCode: dto.hsnCode },
      { $set: updateDoc },
      { upsert: true, new: true },
    ) as unknown as CessRuleDocument;
  }

  /**
   * Longest-prefix HSN match (D-08).
   *
   * Generates a list of HSN prefixes from longest (8 chars) down to shortest (2 chars),
   * fetches all matching active rules, then sorts by prefix length descending
   * so the most specific rule wins.
   *
   * Example: HSN '24021000' → prefixes ['24021000', '2402100', '240210', '24021', '2402', '240', '24']
   * Only '2402' matches → returns that rule.
   *
   * Returns null if no active rule applies.
   */
  async findApplicableForHsn(
    hsn: string,
    atDate: Date = new Date(),
  ): Promise<CessRuleDocument | null> {
    if (!hsn) return null;

    // Build all prefix lengths from longest to shortest (min 2 chars per GST HSN convention)
    const prefixes: string[] = [];
    for (let len = Math.min(hsn.length, 8); len >= 2; len--) {
      prefixes.push(hsn.slice(0, len));
    }

    const rules = await this.model
      .find({
        hsnCode: { $in: prefixes },
        isActive: true,
        applicableFrom: { $lte: atDate },
        $or: [
          { applicableTo: { $exists: false } },
          { applicableTo: null },
          { applicableTo: { $gte: atDate } },
        ],
      })
      .lean() as unknown as CessRuleDocument[];

    if (rules.length === 0) return null;

    // Sort by hsnCode length descending — longest prefix wins (most specific rule)
    rules.sort((a, b) => b.hsnCode.length - a.hsnCode.length);
    return rules[0];
  }

  /** Soft-deactivate a rule by ID */
  async deactivate(id: string): Promise<void> {
    await this.model.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { isActive: false } },
    );
  }
}
