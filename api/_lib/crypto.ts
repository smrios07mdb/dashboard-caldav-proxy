import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // standard nonce length for GCM
const TAG_BYTES = 16; // GCM auth tag length

// Read the key lazily (per call) so the module imports cleanly in tests/build
// before env is set, and so Vercel's runtime env is picked up at request time.
function getKey(): Buffer {
  const raw = process.env.CALDAV_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('CALDAV_ENCRYPTION_KEY is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `CALDAV_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Encrypt a UTF-8 string. Returns IV(12) ‖ ciphertext ‖ tag(16) as raw bytes. */
export async function encrypt(plain: string): Promise<Buffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

/** Inverse of {@link encrypt}. Throws if the blob is malformed or tampered. */
export async function decrypt(blob: Buffer): Promise<string> {
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted blob too short to contain IV + auth tag');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
