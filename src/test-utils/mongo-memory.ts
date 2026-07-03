// Shared mongodb-memory-server lifecycle helper for integration tests.
// Do NOT name this file *.vitest.ts — it's a utility, not a suite.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection } from 'mongoose';

export interface TestMongo {
  mongod: MongoMemoryServer;
  connection: Connection;
  uri: string;
}

/**
 * Start an in-memory MongoDB, connect mongoose to it, and return handles.
 * Usage (inside a Vitest suite):
 *
 *   let mongo: TestMongo;
 *   beforeAll(async () => { mongo = await createTestMongoose(); });
 *   afterAll(async () => { await stopTestMongoose(mongo); });
 *
 * beforeEach should clear collections via `clearCollections(mongo)`
 * for clean state between tests.
 */
export async function createTestMongoose(): Promise<TestMongo> {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  return {
    mongod,
    connection: mongoose.connection,
    uri,
  };
}

export async function stopTestMongoose(ctx: TestMongo | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await mongoose.disconnect();
  } catch {
    // already disconnected
  }
  try {
    await ctx.mongod.stop();
  } catch {
    // already stopped
  }
}

/**
 * Drop every collection in the active connection. Cheaper than dropDatabase
 * because indexes survive. Use in beforeEach for test isolation.
 */
export async function clearCollections(ctx: TestMongo): Promise<void> {
  const collections = await ctx.connection.db!.collections();
  for (const col of collections) {
    await col.deleteMany({});
  }
}
