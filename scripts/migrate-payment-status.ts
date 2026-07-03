/**
 * One-time migration: set status='active' on all existing payments
 * Run with: npx ts-node scripts/migrate-payment-status.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

async function migrate() {
  const uri =
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    'mongodb://localhost:27017/zari360';
  console.log('Connecting to:', uri.replace(/\/\/.*@/, '//***@'));

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const paymentResult = await db.collection('payments').updateMany(
    { status: { $exists: false } },
    { $set: { status: 'active' } },
  );
  console.log(
    `Payments: ${paymentResult.modifiedCount} documents updated with status='active'`,
  );

  const collectionNames = (await db.listCollections().toArray()).map(
    (collection) => collection.name,
  );
  const adjustmentCollectionName = collectionNames.includes('salaryadjustments')
    ? 'salaryadjustments'
    : collectionNames.includes('salary_adjustments')
      ? 'salary_adjustments'
      : 'salaryadjustments';

  const adjResult = await db
    .collection(adjustmentCollectionName)
    .updateMany(
      { source: { $exists: false } },
      { $set: { source: 'manual' } },
    );
  console.log(
    `Adjustments (${adjustmentCollectionName}): ${adjResult.modifiedCount} documents updated with source='manual'`,
  );

  await mongoose.disconnect();
  console.log('Migration complete.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
