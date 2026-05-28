import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock jose. vi.hoisted gives the mock fns a stable identity the factory can
// reference (vi.mock is hoisted above imports).
const { jwtVerifyMock, createRemoteJWKSetMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  createRemoteJWKSetMock: vi.fn(() => 'MOCK_JWKS'),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: createRemoteJWKSetMock,
  jwtVerify: jwtVerifyMock,
}));

import { requireUser } from '../api/_lib/auth';

function reqWith(authorization?: string): Request {
  return new Request('https://proxy.example/api/calendar/busy', {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createRemoteJWKSetMock.mockReturnValue('MOCK_JWKS');
  process.env.SUPABASE_JWKS_URL = 'https://proj.supabase.co/auth/v1/.well-known/jwks.json';
});

describe('requireUser', () => {
  it('returns userId from the sub claim on a valid ES256 token', async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { sub: 'user-123' } });

    await expect(requireUser(reqWith('Bearer good.token.sig'))).resolves.toEqual({
      userId: 'user-123',
    });
    // Must pin verification to ES256 (Supabase JWKS publishes ES256/P-256).
    expect(jwtVerifyMock).toHaveBeenCalledWith('good.token.sig', 'MOCK_JWKS', {
      algorithms: ['ES256'],
    });
  });

  it('rejects when the Authorization header is missing', async () => {
    await expect(requireUser(reqWith())).rejects.toThrow();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects when the scheme is not Bearer', async () => {
    await expect(requireUser(reqWith('Basic abc'))).rejects.toThrow();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid token (jose throws)', async () => {
    jwtVerifyMock.mockRejectedValue(new Error('signature verification failed'));
    await expect(requireUser(reqWith('Bearer bad.token'))).rejects.toThrow();
  });

  it('rejects a verified token that has no sub claim', async () => {
    jwtVerifyMock.mockResolvedValue({ payload: { aud: 'authenticated' } });
    await expect(requireUser(reqWith('Bearer nosub'))).rejects.toThrow();
  });
});
