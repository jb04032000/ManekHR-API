import { describe, it } from 'vitest';

describe('AssetMachineLinkService', () => {
  it.todo('links machine to asset bidirectionally inside MongoDB transaction');
  it.todo('refuses link when asset already linked to a different machine (409 with existingMachineId)');
  it.todo('refuses link when machine already linked to a different asset (409 with existingAssetId)');
  it.todo('idempotent: linking same machine to same asset twice succeeds without error');
  it.todo('unlink clears both FixedAsset.machineId and Machine.fixedAssetId atomically');
  it.todo('unlink is idempotent when already unlinked (returns alreadyUnlinked: true)');
  it.todo('throws NotFoundException when fixed asset does not exist');
  it.todo('throws NotFoundException when machine does not exist');
});
