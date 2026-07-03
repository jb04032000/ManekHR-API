import { Model, PopulateOptions } from 'mongoose';
import { PaginationDto, PaginatedResult } from '../dto/pagination.dto';
import { PAGINATION_THRESHOLD } from '../constants';

type SortRecord = Record<string, 1 | -1>;
type MongoFilter = Record<string, unknown> & {
  $or?: Record<string, unknown>[];
  $and?: Record<string, unknown>[];
};

export class QueryHelper {
  /**
   * Applies pagination, sorting, and filtering to a Mongoose query.
   *
   * Small datasets (total ≤ PAGINATION_THRESHOLD): returns all matching
   * records in a single page — no skip/limit applied.
   *
   * Large datasets (total > PAGINATION_THRESHOLD): applies standard
   * page/limit pagination.
   */
  static async paginate<T>(
    model: Model<T>,
    baseFilter: Record<string, unknown>,
    options: PaginationDto,
    searchFields: string[] = [],
    populateFields: (string | PopulateOptions)[] = [],
  ): Promise<PaginatedResult<T>> {
    const {
      page = 1,
      limit = 10,
      sortBy,
      sortOrder = 'desc',
      search,
    } = options;
    const filters = options.filters as
      | Record<string, unknown>
      | null
      | undefined;

    // Build sort
    const sort: SortRecord = sortBy
      ? { [sortBy]: sortOrder === 'asc' ? 1 : -1 }
      : { createdAt: -1 };

    // Build filter — search and dynamic filters always applied
    const filter: MongoFilter = { ...baseFilter };

    if (search && searchFields.length > 0) {
      const searchOr = searchFields.map((field) => ({
        [field]: { $regex: search, $options: 'i' },
      }));
      if (filter.$or) {
        // Preserve existing $or (e.g. resignation-date guard for active status)
        // by combining both conditions under $and
        filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
        delete filter.$or;
      } else {
        filter.$or = searchOr;
      }
    }

    if (
      filters !== undefined &&
      filters !== null &&
      typeof filters === 'object'
    ) {
      const safeFilters = filters;
      for (const key of Object.keys(safeFilters)) {
        const value: unknown = safeFilters[key];
        if (value !== undefined && value !== null && value !== '') {
          const dbKey = key === 'id' ? '_id' : key;
          filter[dbKey] = Array.isArray(value) ? { $in: value } : value;
        }
      }
    }

    // Count after applying filters so small filtered sets also bypass pagination
    const total = await model.countDocuments(filter).exec();

    if (total <= PAGINATION_THRESHOLD && (page === 1 || !options.page)) {
      const data = await model
        .find(filter)
        .sort(sort)
        .populate(populateFields)
        .exec();
      return { data, total, page: 1, limit: total || 1, pages: 1 };
    }

    const skip = (page - 1) * limit;
    const data = await model
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate(populateFields)
      .exec();

    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
