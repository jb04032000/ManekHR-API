/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * In-memory mock models for AdvertiserWallet and AdWalletLedger.
 *
 * These honour the specific Mongo semantics WalletService relies on:
 *   - findOne with idempotencyKey filter
 *   - findOneAndUpdate with $gte guard, $inc/$set/$setOnInsert, upsert + new
 *   - create with duplicate idempotencyKey -> throws error with code 11000
 */

import { Types } from 'mongoose';

/**
 * Coerce a hex-string id into an ObjectId so the mock stores `ref` fields as
 * real ObjectIds, mirroring Mongo. This keeps services that do ObjectId-equality
 * (`field.equals(id)`) working against the mock the same way they do in prod.
 */
function toObjectId(id: unknown): unknown {
  return typeof id === 'string' && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
}

// ---------------------------------------------------------------------------
// Wallet mock
// ---------------------------------------------------------------------------

type WalletDoc = {
  ownerUserId: string;
  balance: number;
  reserved: number;
  lastTopUpAt?: Date | null;
};

function applyInc(doc: Record<string, any>, inc: Record<string, number>): void {
  for (const [field, delta] of Object.entries(inc)) {
    doc[field] = (doc[field] ?? 0) + delta;
  }
}

function applySet(doc: Record<string, any>, set: Record<string, any>): void {
  for (const [field, value] of Object.entries(set)) {
    doc[field] = value;
  }
}

/**
 * Parse a MongoDB filter object that may include operators like { $gte: n }.
 * Returns true when the document matches all filter conditions.
 */
function matchesFilter(doc: Record<string, any>, filter: Record<string, any>): boolean {
  for (const [field, condition] of Object.entries(filter)) {
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      // Operator condition e.g. { balance: { $gte: 500 } }
      for (const [op, val] of Object.entries(condition as Record<string, any>)) {
        if (op === '$gte' && !(doc[field] >= val)) return false;
        if (op === '$lte' && !(doc[field] <= val)) return false;
        if (op === '$gt' && !(doc[field] > val)) return false;
        if (op === '$lt' && !(doc[field] < val)) return false;
        if (op === '$eq' && doc[field] !== val) return false;
        if (op === '$ne' && doc[field] === val) return false;
      }
    } else {
      // Plain equality
      if (doc[field] !== condition) return false;
    }
  }
  return true;
}

export function createWalletModelMock() {
  const store = new Map<string, WalletDoc>();

  return {
    _store: store,

    findOne(filter: Record<string, any>) {
      const userId = filter.ownerUserId as string | undefined;
      if (!userId) return Promise.resolve(null);
      const doc = store.get(userId);
      return Promise.resolve(doc ? { ...doc } : null);
    },

    findOneAndUpdate(
      filter: Record<string, any>,
      update: Record<string, any>,
      opts: { upsert?: boolean; new?: boolean; setDefaultsOnInsert?: boolean } = {},
    ) {
      const userId = filter.ownerUserId as string;
      let doc = store.get(userId);
      const isNew = !doc;

      // Check whether an existing doc satisfies the full filter (including $gte guards).
      if (!isNew && !matchesFilter(doc as any, filter)) {
        // Existing doc does not match filter (e.g. insufficient balance).
        // Do NOT upsert when a guard field is in the filter -- the guard only
        // makes sense on existing docs.
        return Promise.resolve(null);
      }

      if (isNew) {
        if (!opts.upsert) return Promise.resolve(null);
        // New document: start with defaults from $setOnInsert.
        const setOnInsert: Record<string, any> = update['$setOnInsert'] ?? {};
        doc = {
          ownerUserId: userId,
          balance: setOnInsert['balance'] ?? 0,
          reserved: setOnInsert['reserved'] ?? 0,
          lastTopUpAt: setOnInsert['lastTopUpAt'] ?? null,
        };
      }

      // Apply $inc
      if (update['$inc']) applyInc(doc as any, update['$inc'] as Record<string, number>);
      // Apply $set (skip on new inserts when only $setOnInsert was provided for the primary fields)
      if (update['$set']) applySet(doc as any, update['$set'] as Record<string, any>);

      store.set(userId, doc);

      if (opts.new !== false) {
        return Promise.resolve({ ...doc });
      }
      return Promise.resolve(null);
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger mock
// ---------------------------------------------------------------------------

type LedgerDoc = {
  ownerUserId: string;
  type: string;
  amount: number;
  balanceAfter: number;
  reservedAfter: number;
  campaignId?: string;
  idempotencyKey?: string;
  ref?: string;
  note?: string;
  recordedBy?: string;
};

export function createLedgerModelMock() {
  const rows: LedgerDoc[] = [];

  return {
    _rows: rows,

    findOne(filter: Record<string, any>) {
      const match = rows.find((r) => {
        for (const [k, v] of Object.entries(filter)) {
          if ((r as any)[k] !== v) return false;
        }
        return true;
      });
      return Promise.resolve(match ?? null);
    },

    create(doc: Partial<LedgerDoc>) {
      // Enforce partial unique on idempotencyKey.
      if (doc.idempotencyKey !== undefined) {
        const existing = rows.find((r) => r.idempotencyKey === doc.idempotencyKey);
        if (existing) {
          const err = new Error('E11000 duplicate key') as Error & { code: number };
          err.code = 11000;
          return Promise.reject(err);
        }
      }
      const row = { ...doc } as LedgerDoc;
      rows.push(row);
      return Promise.resolve(row);
    },

    // Removes the first row matching the (equality-only) filter. Used by the
    // claim-first debit to release an idempotency claim on insufficient reserved.
    deleteOne(filter: Record<string, any>) {
      const idx = rows.findIndex((r) => {
        for (const [k, v] of Object.entries(filter)) {
          if ((r as any)[k] !== v) return false;
        }
        return true;
      });
      if (idx >= 0) rows.splice(idx, 1);
      return Promise.resolve({ deletedCount: idx >= 0 ? 1 : 0 });
    },

    // Applies $set to the first row matching the (equality-only) filter. Used by
    // claim-first debit to finalize the authoritative post-state snapshot.
    updateOne(filter: Record<string, any>, update: Record<string, any>) {
      const row = rows.find((r) => {
        for (const [k, v] of Object.entries(filter)) {
          if ((r as any)[k] !== v) return false;
        }
        return true;
      });
      if (row && update['$set']) Object.assign(row, update['$set']);
      return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
    },
  };
}

// ---------------------------------------------------------------------------
// Topup intent mock (AdWalletTopup)
// ---------------------------------------------------------------------------

type TopupDoc = {
  _id: string;
  // Stored as an ObjectId (like the real `ref: 'User'` field) so ownership
  // checks that use `.equals()` behave the same against the mock as in prod.
  ownerUserId: string | Types.ObjectId;
  amountRupees: number;
  amountPaise: number;
  currency: string;
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  status: string;
};

/**
 * In-memory mock for the AdWalletTopup model. Honours the semantics the
 * checkout service relies on:
 *   - create(doc) -> assigns an _id, stores, returns a doc with a `.save()`
 *     spy so the service can mutate then persist.
 *   - findById(id).exec() -> returns the stored doc (with `.save()`) or null.
 *
 * Test-only helpers: `_seed` to pre-load an intent, `_byId` to read current
 * state, `_rows` to assert what was persisted.
 */
export function createTopupModelMock() {
  const store = new Map<string, TopupDoc & { save: () => Promise<unknown> }>();
  let seq = 0;

  function nextId(): string {
    seq += 1;
    return `64b0000000000000000000${String(seq).padStart(2, '0')}`;
  }

  function wrap(doc: TopupDoc): TopupDoc & { save: () => Promise<unknown> } {
    const wrapped = doc as TopupDoc & { save: () => Promise<unknown> };
    wrapped.save = () => {
      store.set(wrapped._id, wrapped);
      return Promise.resolve(wrapped);
    };
    return wrapped;
  }

  const api = {
    get _rows(): TopupDoc[] {
      return Array.from(store.values());
    },

    /** Pre-seed an intent. Returns the stored doc (with _id assigned). */
    _seed(doc: Partial<TopupDoc>): TopupDoc & { save: () => Promise<unknown> } {
      const full: TopupDoc = {
        _id: doc._id ?? nextId(),
        ownerUserId: toObjectId(doc.ownerUserId ?? '') as string | Types.ObjectId,
        amountRupees: doc.amountRupees ?? 0,
        amountPaise: doc.amountPaise ?? 0,
        currency: doc.currency ?? 'INR',
        razorpayOrderId: doc.razorpayOrderId ?? '',
        razorpayPaymentId: doc.razorpayPaymentId,
        status: doc.status ?? 'created',
      };
      const wrapped = wrap(full);
      store.set(full._id, wrapped);
      return wrapped;
    },

    /** Read current stored state for an id (no `.save` wrapper noise). */
    _byId(id: string): TopupDoc {
      const doc = store.get(id);
      if (!doc) throw new Error(`topup mock: no doc for id ${id}`);
      return doc;
    },

    create(doc: Partial<TopupDoc>): Promise<TopupDoc & { save: () => Promise<unknown> }> {
      const full: TopupDoc = {
        _id: nextId(),
        ownerUserId: toObjectId(doc.ownerUserId ?? '') as string | Types.ObjectId,
        amountRupees: doc.amountRupees ?? 0,
        amountPaise: doc.amountPaise ?? 0,
        currency: doc.currency ?? 'INR',
        razorpayOrderId: doc.razorpayOrderId ?? '',
        razorpayPaymentId: doc.razorpayPaymentId,
        status: doc.status ?? 'created',
      };
      const wrapped = wrap(full);
      store.set(full._id, wrapped);
      return Promise.resolve(wrapped);
    },

    findById(id: string) {
      return {
        exec: () => Promise.resolve(store.get(id) ?? null),
      };
    },
  };

  return api;
}
