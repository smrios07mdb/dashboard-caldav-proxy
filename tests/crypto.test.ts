import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt } from '../api/_lib/crypto';

beforeAll(() => {
  // 32 random bytes, base64 — mirrors `openssl rand -base64 32`.
  process.env.CALDAV_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

describe('crypto (AES-256-GCM)', () => {
  it('round-trips a secret through encrypt → decrypt', async () => {
    const secret = 'abcd-efgh-ijkl-mnop';
    const blob = await encrypt(secret);

    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(await decrypt(blob)).toBe(secret);
  });

  it('survives a Buffer → bytea → Buffer round-trip (DB storage shape)', async () => {
    // The settings.caldav_app_password_encrypted column is `bytea` (ARCH §4),
    // so the proxy stores raw bytes and reads raw bytes back — no base64 layer.
    // Simulate the DB handing us back a fresh Buffer copy of the same bytes.
    const secret = 'pass with spaces and üñïçödé ✓';
    const written = await encrypt(secret);

    const readBack = Buffer.from(written); // what the bytea column returns
    expect(await decrypt(readBack)).toBe(secret);
  });

  it('uses a fresh IV each call (same input → different ciphertext)', async () => {
    const secret = 'same-input';
    const a = await encrypt(secret);
    const b = await encrypt(secret);

    expect(a.equals(b)).toBe(false);
    expect(await decrypt(a)).toBe(secret);
    expect(await decrypt(b)).toBe(secret);
  });

  it('rejects tampered ciphertext (GCM auth tag fails)', async () => {
    const blob = await encrypt('integrity-protected');
    const tampered = Buffer.from(blob);
    // Flip a bit in the ciphertext region (after the 12-byte IV).
    tampered[13] = (tampered[13] ?? 0) ^ 0x01;

    await expect(decrypt(tampered)).rejects.toThrow();
  });
});
