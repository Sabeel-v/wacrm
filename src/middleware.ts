import { NextResponse, type NextRequest } from 'next/server'
import { getCookieCache, getSessionCookie } from 'better-auth/cookies'

/**
 * Route guard (Better Auth). Runs on the edge, so it never touches D1:
 *
 *   - Protected pages: no session cookie → /login. Optimistic only; every
 *     data request is still authorised server-side (/api/db, routes).
 *   - Auth pages (/login, /signup, /forgot-password): redirect away only
 *     when the *signed, unexpired* session cache verifies. The client's
 *     session check reads the same cache, so the two can't disagree and
 *     bounce the user between /login and /dashboard.
 *   - /api/whatsapp/* (except the Meta webhook): 401 without a session.
 */

const AUTH_PAGES = ['/login', '/signup', '/forgot-password']

// Includes /agents, /flows, /quick-replies, /notifications, which the
// Supabase-era list left out (MIGRATION_ASSESSMENT.md §10.4 #8).
const PROTECTED_PATHS = [
  '/dashboard', '/inbox', '/contacts', '/pipelines', '/pipeline', '/leads', '/reports',
  '/broadcasts', '/templates', '/automations', '/flows', '/agents', '/quick-replies',
  '/notifications', '/settings',
]

const isProtected = (path: string) => PROTECTED_PATHS.some((p) => path === p || path.startsWith(`${p}/`))

async function hasVerifiedSession(request: NextRequest): Promise<boolean> {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) return false
  try {
    // Better Auth issues `__Secure-`-prefixed cookie names in production
    // builds (even on a local http preview) and plain names in dev, so
    // accept either; the value is still signature- and expiry-checked.
    for (const isSecure of [true, false]) {
      if (await getCookieCache(request, { secret, isSecure })) return true
    }
    return false
  } catch {
    return false
  }
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname
  const hasSessionCookie = !!getSessionCookie(request)

  if (AUTH_PAGES.includes(path) && hasSessionCookie && (await hasVerifiedSession(request))) {
    const url = request.nextUrl.clone()
    // Signed-in user following an invite link: go straight to accepting it.
    const inviteToken = request.nextUrl.searchParams.get('invite')
    url.pathname = inviteToken && path !== '/forgot-password' ? `/join/${encodeURIComponent(inviteToken)}` : '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  if (!hasSessionCookie && isProtected(path)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return NextResponse.redirect(url)
  }

  if (!hasSessionCookie && path.startsWith('/api/whatsapp/') && !path.includes('/webhook')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
