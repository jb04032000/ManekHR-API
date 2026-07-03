import * as crypto from 'crypto';
import { env } from '../../../../config/env';

/**
 * AES-256-GCM decrypt for secrets stored at rest (Razorpay keys, webhook secrets, etc.).
 *
 * Storage format (base64-encoded): <12-byte IV> | <ciphertext> | <16-byte auth tag>
 * Encryption key: FIELD_ENCRYPTION_KEY env var (32-byte hex string = 64 hex chars).
 *
 * MANUAL-VERIFY: ensure FIELD_ENCRYPTION_KEY is set in production environment and
 * matches the key used during encryption (e.g. in firm settings save flow).
 */
export function decryptFieldValue(encryptedBase64: string): string {
  const keyHex = env.crypto.fieldEncryptionKey;
  if (!keyHex) {
    throw new Error('FIELD_ENCRYPTION_KEY env var is not set — cannot decrypt sensitive field');
  }

  const buf = Buffer.from(encryptedBase64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
