import { env } from '../config/env';

/**
 * If the total number of matching records is at or below this threshold,
 * QueryHelper.paginate() returns all records in a single page without
 * applying skip/limit. Above this count, standard page-based pagination
 * is applied.
 *
 * Configure via the PAGINATION_THRESHOLD environment variable.
 * Default: 200
 */
export const PAGINATION_THRESHOLD = env.paginationThreshold;
