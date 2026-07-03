/**
 * Migration Script: Backfill inviteeIdentifier for existing placeholder users
 * 
 * Purpose: Before making userId nullable, this script backfills existing placeholder users
 * by extracting their identifier and converting them to the new schema format.
 * 
 * Usage: node dist/scripts/migrations/001-workspace-member-invitee-identifier.js
 * 
 * This script is idempotent - safe to run multiple times.
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/zari360';

const userSchema = new mongoose.Schema({
  name: String,
  email: String,
  mobile: String,
  isActive: Boolean,
}, { _id: true });

const workspaceMemberSchema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
  status: String,
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  inviteToken: String,
  inviteTokenHash: String,
  inviteExpiry: Date,
  inviteeIdentifier: String,
  inviteeType: String,
  joinedAt: Date,
}, { timestamps: true });

async function runMigration() {
  console.log('[Migration] Starting workspace member backfill...');
  
  await mongoose.connect(MONGO_URI);
  console.log('[Migration] Connected to MongoDB');

  const User = mongoose.model('User', userSchema);
  const WorkspaceMember = mongoose.model('WorkspaceMember', workspaceMemberSchema);

  let processed = 0;
  let backfilled = 0;
  let skipped = 0;

  // Find all invited members
  const invitedMembers = await WorkspaceMember.find({ status: 'invited' }).exec();
  console.log(`[Migration] Found ${invitedMembers.length} invited members`);

  for (const member of invitedMembers) {
    processed++;

    // If userId is already set, this is a real user - skip
    if (member.userId) {
      skipped++;
      continue;
    }

    // Find the associated user (if any)
    if (!member.userId) {
      // This is a placeholder user scenario - check if there's a user with matching email/mobile
      // In the old implementation, inviteToken was stored on the member
      if (member.inviteToken) {
        // We can't recover the identifier from inviteToken - these are legacy invites
        // Just mark them as having no inviteeIdentifier for now
        console.log(`[Migration] Member ${member._id} has no userId but has inviteToken - cannot recover identifier`);
        skipped++;
        continue;
      }

      // If no inviteToken and no userId, this shouldn't happen in normal flow
      skipped++;
    }
  }

  // Alternative approach: Find all users that look like placeholders
  // "Pending Invite" users that are isActive: false
  const placeholderUsers = await User.find({
    name: 'Pending Invite',
    isActive: false,
  }).exec();

  console.log(`[Migration] Found ${placeholderUsers.length} placeholder users`);

  for (const placeholderUser of placeholderUsers) {
    // Find member records that reference this user
    const memberRecords = await WorkspaceMember.find({
      userId: placeholderUser._id,
      status: 'invited',
    }).exec();

    for (const member of memberRecords) {
      // Backfill the inviteeIdentifier and clear userId
      const identifier = placeholderUser.email || placeholderUser.mobile;
      const inviteeType = placeholderUser.email ? 'email' : 'mobile';

      member.inviteeIdentifier = identifier;
      member.inviteeType = inviteeType;
      member.userId = null;
      
      await member.save();
      
      // Delete the placeholder user
      await User.deleteOne({ _id: placeholderUser._id });

      backfilled++;
      console.log(`[Migration] Backfilled member ${member._id} with identifier ${identifier}`);
    }
  }

  console.log(`[Migration] Summary: processed=${processed}, backfilled=${backfilled}, skipped=${skipped}`);
  console.log('[Migration] Migration complete');

  await mongoose.disconnect();
  process.exit(0);
}

runMigration().catch(err => {
  console.error('[Migration] Error:', err);
  process.exit(1);
});
