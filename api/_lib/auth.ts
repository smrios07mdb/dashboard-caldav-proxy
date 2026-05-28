import { createRemoteJWKSet, jwtVerify } from 'jose';

// Supabase signs JWTs with ES256 (asymmetric, P-256) and publishes the public
// keys at SUPABASE_JWKS_URL. We verify against that key set — never a shared
// secret. The remote key set is cached across invocations (it self-refreshes
// on unknown `kid`), so create it once per warm Lambda.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    const url = process.env.SUPABASE_JWKS_URL;
    if (!url) {
      throw new Error('SUPABASE_JWKS_URL is not set');
    }
    jwks = createRemoteJWKSet(new URL(url));
  }
  return jwks;
}

/** Thrown when a request has no valid Supabase JWT. Endpoints map this to 401. */
export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Validate the `Authorization: Bearer <jwt>` header and return the user id.
 * The returned `userId` is the verified `sub` claim — the ONLY trusted source
 * of the caller's identity (never read a user id from the request body).
 */
export async function requireUser(req: Request): Promise<{ userId: string }> {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError('missing bearer token');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new UnauthorizedError('missing bearer token');
  }

  let sub: string | undefined;
  try {
    const { payload } = await jwtVerify(token, getJwks(), { algorithms: ['ES256'] });
    sub = payload.sub;
  } catch {
    throw new UnauthorizedError('invalid token');
  }

  if (!sub) {
    throw new UnauthorizedError('token missing sub claim');
  }
  return { userId: sub };
}
