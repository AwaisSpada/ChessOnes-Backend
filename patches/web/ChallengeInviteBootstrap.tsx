/**
 * Drop-in web invite handler for ChessOnes Next.js frontend.
 *
 * Mount once in the authenticated app shell (e.g. /home layout) OR a client
 * provider that wraps logged-in routes:
 *
 *   import { ChallengeInviteBootstrap } from '@/patches/ChallengeInviteBootstrap'
 *   <ChallengeInviteBootstrap apiBase={process.env.NEXT_PUBLIC_API_URL!} />
 *
 * Behavior (chess.com-style):
 * - Reads ?invite=TOKEN from the URL
 * - If no auth token → redirect to /login?next=/home?invite=TOKEN
 * - If authed → POST /invitations/:token/respond { action: 'accept' }
 * - On success → router.push to live game route
 * - Clears invite query param; surfaces expired/claimed/own-link errors
 *
 * Adjust `getAccessToken`, `loginPath`, and `gamePath` to match your FE.
 */

'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

type Props = {
  /** e.g. https://chessones-backend-u7rz.onrender.com/api */
  apiBase: string;
  /** Return current JWT or null */
  getAccessToken: () => string | null | undefined;
  /** Where to send unauthenticated users (default /login) */
  loginPath?: string;
  /** Build live-game href from gameId (default /home?gameId=) */
  gamePath?: (gameId: string) => string;
  /** Optional toast/alert */
  onError?: (message: string) => void;
  onSuccess?: (gameId: string) => void;
};

export function ChallengeInviteBootstrap({
  apiBase,
  getAccessToken,
  loginPath = '/login',
  gamePath = (gameId) => `/home?gameId=${encodeURIComponent(gameId)}`,
  onError,
  onSuccess,
}: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const pathname = usePathname();
  const busy = useRef(false);

  useEffect(() => {
    const token = search?.get('invite')?.trim();
    if (!token || busy.current) return;

    const access = getAccessToken();
    if (!access) {
      const next = `${pathname || '/home'}?invite=${encodeURIComponent(token)}`;
      router.replace(
        `${loginPath}?next=${encodeURIComponent(next)}`
      );
      return;
    }

    busy.current = true;
    void (async () => {
      try {
        const res = await fetch(
          `${apiBase.replace(/\/$/, '')}/invitations/${encodeURIComponent(token)}/respond`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${access}`,
            },
            body: JSON.stringify({ action: 'accept' }),
          }
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.success) {
          throw new Error(json?.message || 'Failed to accept challenge');
        }
        const gameId =
          json?.data?.game?.gameId ||
          json?.data?.invitation?.gameId ||
          json?.data?.gameId;
        if (!gameId) throw new Error('Game id missing after accept');

        // Drop invite query so refresh doesn't re-accept
        router.replace(gamePath(String(gameId)));
        onSuccess?.(String(gameId));
      } catch (e) {
        const message =
          e instanceof Error ? e.message : 'Could not join challenge';
        onError?.(message);
        // Remove broken invite from URL
        router.replace(pathname || '/home');
      } finally {
        busy.current = false;
      }
    })();
  }, [
    apiBase,
    gamePath,
    getAccessToken,
    loginPath,
    onError,
    onSuccess,
    pathname,
    router,
    search,
  ]);

  return null;
}
