/**
 * One-time migration: normalize salary mode specific fields on team members.
 *
 * Deployment order:
 * 1. Take a DB snapshot / backup
 * 2. Run: npx ts-node scripts/migrate-salary-mode-config.ts --dry-run
 * 3. Review stdout output, especially anomalies
 * 4. Run: npx ts-node scripts/migrate-salary-mode-config.ts
 * 5. Deploy backend
 * 6. Deploy frontend
 *
 * Rollback:
 * - If the dry-run output looks wrong, stop before the live run.
 * - If the live cleanup behaves unexpectedly, restore the snapshot taken in step 1.
 *
 * The script is idempotent and safe to rerun. Logs are written to stdout.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const VALID_SALARY_TYPES = ['monthly', 'hourly'] as const;
const DRY_RUN = process.argv.includes('--dry-run');

type CollectionWithDb = NonNullable<typeof mongoose.connection.db>;

async function resolveTeamCollectionName(db: CollectionWithDb) {
  const collectionNames = (await db.listCollections().toArray()).map(
    (collection) => collection.name,
  );

  if (collectionNames.includes('teammembers')) {
    return 'teammembers';
  }

  if (collectionNames.includes('team_members')) {
    return 'team_members';
  }

  throw new Error(
    'Could not determine the team member collection name (expected teammembers or team_members).',
  );
}

async function logSalaryTypeAnomalies(
  teamCollection: ReturnType<CollectionWithDb['collection']>,
) {
  const anomalyFilter = {
    $or: [
      { salaryType: { $exists: false } },
      { salaryType: null },
      { salaryType: { $nin: [...VALID_SALARY_TYPES] } },
    ],
  };

  const count = await teamCollection.countDocuments(anomalyFilter);
  if (count === 0) {
    console.log('[Migration] No salaryType anomalies found.');
    return 0;
  }

  const sample = await teamCollection
    .find(anomalyFilter)
    .project({ _id: 1, workspaceId: 1, name: 1, salaryType: 1 })
    .limit(25)
    .toArray();

  console.log(
    `[Migration] Found ${count} team members with missing or invalid salaryType. Review these before running the live cleanup:`,
  );
  console.log(JSON.stringify(sample, null, 2));

  return count;
}

async function migrate() {
  const uri =
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    'mongodb://localhost:27017/zari360';

  console.log(
    `[Migration] Starting salary mode cleanup (${DRY_RUN ? 'dry-run' : 'live'})`,
  );
  console.log('Connecting to:', uri.replace(/\/\/.*@/, '//***@'));

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB connection is not available.');
  }

  const teamCollectionName = await resolveTeamCollectionName(db);
  const teamCollection = db.collection(teamCollectionName);

  console.log(`[Migration] Using collection: ${teamCollectionName}`);

  const anomalyCount = await logSalaryTypeAnomalies(teamCollection);
  if (anomalyCount > 0 && !DRY_RUN) {
    throw new Error(
      'Aborting live cleanup because missing/invalid salaryType rows were found. Review the dry-run output first.',
    );
  }

  const hourlyCleanupFilter = {
    salaryType: 'hourly',
    $or: [
      { ctcAmount: { $exists: true } },
      { componentTemplateId: { $exists: true } },
      { 'componentOverrides.0': { $exists: true } },
    ],
  };

  const monthlyCleanupFilter = {
    salaryType: 'monthly',
    $or: [
      { dailyHours: { $exists: true } },
      { workingDays: { $exists: true } },
      { finalMonthlyOverride: { $exists: true } },
    ],
  };

  const hourlyMatched = await teamCollection.countDocuments(hourlyCleanupFilter);
  const monthlyMatched = await teamCollection.countDocuments(
    monthlyCleanupFilter,
  );

  console.log(
    `[Migration] Hourly rows with stale CTC/template fields: ${hourlyMatched}`,
  );
  console.log(
    `[Migration] Monthly rows with stale hourly-only fields: ${monthlyMatched}`,
  );

  if (DRY_RUN) {
    const hourlySample = await teamCollection
      .find(hourlyCleanupFilter)
      .project({
        _id: 1,
        workspaceId: 1,
        name: 1,
        salaryType: 1,
        ctcAmount: 1,
        componentTemplateId: 1,
        componentOverrides: 1,
      })
      .limit(10)
      .toArray();
    const monthlySample = await teamCollection
      .find(monthlyCleanupFilter)
      .project({
        _id: 1,
        workspaceId: 1,
        name: 1,
        salaryType: 1,
        dailyHours: 1,
        workingDays: 1,
        finalMonthlyOverride: 1,
      })
      .limit(10)
      .toArray();

    console.log('[Migration] Hourly sample rows to be cleaned:');
    console.log(JSON.stringify(hourlySample, null, 2));
    console.log('[Migration] Monthly sample rows to be cleaned:');
    console.log(JSON.stringify(monthlySample, null, 2));
    console.log('[Migration] Dry-run complete. No documents were changed.');
    await mongoose.disconnect();
    return;
  }

  const hourlyResult = await teamCollection.updateMany(hourlyCleanupFilter, {
    $unset: {
      ctcAmount: '',
      componentTemplateId: '',
    },
    $set: {
      componentOverrides: [],
    },
  });

  const monthlyResult = await teamCollection.updateMany(monthlyCleanupFilter, {
    $unset: {
      dailyHours: '',
      workingDays: '',
      finalMonthlyOverride: '',
    },
  });

  console.log(
    `[Migration] Hourly cleanup matched=${hourlyResult.matchedCount} modified=${hourlyResult.modifiedCount}`,
  );
  console.log(
    `[Migration] Monthly cleanup matched=${monthlyResult.matchedCount} modified=${monthlyResult.modifiedCount}`,
  );

  await mongoose.disconnect();
  console.log('[Migration] Salary mode cleanup complete.');
}

migrate().catch((err) => {
  console.error('[Migration] Error:', err);
  process.exit(1);
});
