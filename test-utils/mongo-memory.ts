/**
 * Phase 16 (Plan 01) — Shared MongoMemoryServer harness for integration tests.
 *
 * Used by FY-close transactional tests, PortalAccessToken revoke tests, and
 * any future test that needs an isolated, in-memory MongoDB instance.
 *
 * Usage:
 *
 *   import { startMemoryMongo, stopMemoryMongo, clearAllCollections } from '../../test-utils/mongo-memory';
 *
 *   beforeAll(async () => { await startMemoryMongo(); });
 *   afterAll(async () => { await stopMemoryMongo(); });
 *   afterEach(async () => { await clearAllCollections(); });
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connect, disconnect, connection } from 'mongoose';

let server: MongoMemoryServer | null = null;

export async function startMemoryMongo(): Promise<string> {
  if (server) {
    return server.getUri();
  }
  // Replica-set mode required for transactional tests (FY-close uses
  // mongoSession.withTransaction()).
  server = await MongoMemoryServer.create({
    instance: { storageEngine: 'wiredTiger' },
  });
  const uri = server.getUri();
  await connect(uri);
  return uri;
}

export async function stopMemoryMongo(): Promise<void> {
  await disconnect();
  if (server) {
    await server.stop();
    server = null;
  }
}

export async function clearAllCollections(): Promise<void> {
  const collections = connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

export function getMemoryUri(): string | null {
  return server ? server.getUri() : null;
}
