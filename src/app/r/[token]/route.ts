import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { recordBroadcastUrlClick } from '@/lib/whatsapp/broadcast-button-tracking';

// Lazy-initialized admin client for public redirect route
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function getAdminClient() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

/**
 * GET /r/[token]
 *
 * Method 2: Public URL Redirect Tracking Endpoint
 *
 * 1. Resolves token against broadcast_url_tokens.
 * 2. Records click into broadcast_button_clicks (button_type = 'URL').
 * 3. Sends HTTP 302 redirect to the destination website URL with no-cache headers.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;

    if (!token || typeof token !== 'string') {
      return new NextResponse('Invalid tracking token', { status: 400 });
    }

    const adminDb = getAdminClient();
    const { destinationUrl, error } = await recordBroadcastUrlClick(adminDb, token.trim());

    if (!destinationUrl) {
      console.warn(`[url-redirect] Token lookup failed: ${token}`, error);
      return new NextResponse('Link not found or expired', { status: 404 });
    }

    let target = destinationUrl.trim();
    if (!/^https?:\/\//i.test(target)) {
      target = 'https://' + target;
    }

    const response = NextResponse.redirect(target, 302);
    response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
    return response;
  } catch (err) {
    console.error('[url-redirect] Unexpected error in redirect route:', err);
    return new NextResponse('Internal server error', { status: 500 });
  }
}
