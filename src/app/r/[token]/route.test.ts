import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

vi.mock('@/lib/whatsapp/broadcast-button-tracking', () => ({
  recordBroadcastUrlClick: vi.fn(),
}));

import { recordBroadcastUrlClick } from '@/lib/whatsapp/broadcast-button-tracking';

describe('GET /r/[token] - URL redirect tracking endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when token is invalid or expired', async () => {
    (recordBroadcastUrlClick as any).mockResolvedValue({
      destinationUrl: null,
      error: 'Token not found',
    });

    const req = new NextRequest('http://localhost/r/invalid_tok');
    const res = await GET(req, { params: Promise.resolve({ token: 'invalid_tok' }) });

    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain('Link not found or expired');
  });

  it('returns 302 redirect to target website when token is valid', async () => {
    (recordBroadcastUrlClick as any).mockResolvedValue({
      destinationUrl: 'https://mssolutionslearning.com',
    });

    const req = new NextRequest('http://localhost/r/tok_123');
    const res = await GET(req, { params: Promise.resolve({ token: 'tok_123' }) });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://mssolutionslearning.com/');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('prepends https:// if protocol is missing from destination url', async () => {
    (recordBroadcastUrlClick as any).mockResolvedValue({
      destinationUrl: 'mssolutionslearning.com',
    });

    const req = new NextRequest('http://localhost/r/tok_noprotocol');
    const res = await GET(req, { params: Promise.resolve({ token: 'tok_noprotocol' }) });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://mssolutionslearning.com/');
  });
});
