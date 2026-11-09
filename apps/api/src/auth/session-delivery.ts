import type { CookieOptions, Request, Response } from 'express';
import type { TokenPair } from './token.service';

export const REFRESH_COOKIE = 'ls_rt';

export function refreshCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/api/v1/auth' };
}

/** Web: refresh token only in an httpOnly, SameSite=strict cookie. Mobile opt-in (`X-Client-Type: mobile`): also in body. */
export function deliverSession(t: TokenPair, req: Request, res: Response, secure: boolean) {
  res.cookie(REFRESH_COOKIE, t.refreshToken, { ...refreshCookieOptions(secure), expires: t.refreshExpiresAt });
  const mobile = req.header('x-client-type') === 'mobile';
  return {
    accessToken: t.accessToken,
    tokenType: 'Bearer',
    expiresIn: t.accessTokenExpiresIn,
    ...(mobile ? { refreshToken: t.refreshToken, refreshExpiresAt: t.refreshExpiresAt } : {}),
  };
}
