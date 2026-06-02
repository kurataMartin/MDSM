/**
 * proxy.js  (Edge runtime — runs before every matched request)
 *
 * Responsibilities
 * ─────────────────
 * 1. Auth gate  — protect /kyc and /dashboards routes
 * 2. KYC gate   — redirect unapproved users away from /dashboards → /kyc
 * 3. Cache-Control headers on read-heavy GET API routes so the Next.js
 *    data cache / CDN edge can serve stale-while-revalidate responses
 *    instead of hitting Postgres or the Besu RPC on every request.
 */

import { NextResponse } from 'next/server';

// ── Read-route cache policy ──────────────────────────────────────────────────
const READ_CACHE_RULES = [
  { pattern: /^\/api\/market(\/|$)/,              maxAge: 20,  swr: 40  },
  { pattern: /^\/api\/securities(\/|$)/,           maxAge: 60,  swr: 120 },
  { pattern: /^\/api\/blockchain-records(\/|$)/,   maxAge: 300, swr: 600 },
  { pattern: /^\/api\/trades$/,                    maxAge: 20,  swr: 60  },
  { pattern: /^\/api\/clearings(\/|$)/,            maxAge: 60,  swr: 180 },
];

function buildCacheHeader(pathname) {
  for (const rule of READ_CACHE_RULES) {
    if (rule.pattern.test(pathname)) {
      return `public, s-maxage=${rule.maxAge}, stale-while-revalidate=${rule.swr}`;
    }
  }
  return null;
}

// ── Proxy (replaces deprecated middleware.js convention) ─────────────────────

export default function proxy(request) {
  const { pathname } = request.nextUrl;
  const method       = request.method;

  // ── 1. Cache-Control injection for idempotent read routes ────────────────
  if (method === 'GET') {
    const directive = buildCacheHeader(pathname);
    if (directive) {
      const res = NextResponse.next();
      res.headers.set('Cache-Control', directive);
      return res;
    }
  }

  // ── 2. Auth + KYC gates ───────────────────────────────────────────────────
  const needsAuth =
    pathname.startsWith('/kyc') || pathname.startsWith('/dashboards');

  if (needsAuth) {
    let user = null;
    try {
      const raw = request.cookies.get('user_session')?.value;
      if (raw) user = JSON.parse(raw);
    } catch {
      // Malformed cookie → treat as logged out
    }

    if (!user?.id) {
      return NextResponse.redirect(new URL('/', request.url));
    }

    // Admin and regulator are system roles — exempt from KYC requirement.
    // Users may reach their dashboard once KYC is at least SUBMITTED (they see
    // an "under review" banner; full trading stays gated until 'approved').
    // Only users who have not submitted yet (pending / rejected / none) are
    // sent to the KYC form.
    const kycExemptRoles = ['admin', 'regulator'];
    const kycCleared = user.kyc_status === 'approved' || user.kyc_status === 'submitted';
    if (
      pathname.startsWith('/dashboards') &&
      !kycExemptRoles.includes(user.role) &&
      !kycCleared
    ) {
      return NextResponse.redirect(new URL('/kyc', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/kyc/:path*',
    '/dashboards/:path*',
    '/api/market/:path*',
    '/api/securities/:path*',
    '/api/blockchain-records/:path*',
    '/api/trades',
    '/api/clearings/:path*',
  ],
};
