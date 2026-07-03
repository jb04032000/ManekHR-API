import { IsOptional, IsDateString, ValidateIf } from 'class-validator';

// Body for PATCH .../firms/:firmId/books-lock (D21). Set a date to lock all postings/edits
// dated on or before it; send null to clear the lock.
export class SetBooksLockDto {
  @ValidateIf((o: SetBooksLockDto) => o.lockedUptoDate !== null)
  @IsOptional()
  @IsDateString()
  lockedUptoDate?: string | null;
}
