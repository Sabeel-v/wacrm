import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as getButtonStats } from './route';
import { GET as exportButtonUsers } from './[buttonIndex]/export/route';

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(),
  toErrorResponse: (err: unknown) => {
    return new Response(JSON.stringify({ error: (err as Error)?.message || 'Error' }), {
      status: 500,
    });
  },
}));

vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: vi.fn(),
}));

import { requireRole } from '@/lib/auth/account';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

describe('Broadcast Buttons Analytics & Export API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/whatsapp/broadcast/[id]/buttons', () => {
    it('returns 404 when broadcast is not found', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          }),
        }),
      };

      (requireRole as any).mockResolvedValue({
        supabase: mockSupabase,
        accountId: 'acc-1',
        userId: 'usr-1',
      });

      const req = new NextRequest('http://localhost/api/whatsapp/broadcast/bc-1/buttons');
      const res = await getButtonStats(req, { params: Promise.resolve({ id: 'bc-1' }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toBe('Broadcast not found');
    });

    it('returns hasButtons: false when template has no buttons', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: 'bc-1',
                    template_name: 'no_btns',
                    template_language: 'en_US',
                    delivered_count: 100,
                    sent_count: 100,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };

      (requireRole as any).mockResolvedValue({
        supabase: mockSupabase,
        accountId: 'acc-1',
        userId: 'usr-1',
      });

      (resolveTemplateRow as any).mockResolvedValue({
        row: {
          name: 'no_btns',
          buttons: [],
        },
      });

      const req = new NextRequest('http://localhost/api/whatsapp/broadcast/bc-1/buttons');
      const res = await getButtonStats(req, { params: Promise.resolve({ id: 'bc-1' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.hasButtons).toBe(false);
      expect(body.buttons).toEqual([]);
    });

    it('returns button stats with calculated percentages', async () => {
      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: 'bc-1',
                    template_name: 'with_btns',
                    template_language: 'en_US',
                    delivered_count: 1000,
                    sent_count: 1000,
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
        rpc: vi.fn().mockResolvedValue({
          data: [
            {
              button_index: 0,
              button_name: 'Join Now',
              button_type: 'QUICK_REPLY',
              total_clicks: 250,
              unique_users: 180,
            },
          ],
          error: null,
        }),
      };

      (requireRole as any).mockResolvedValue({
        supabase: mockSupabase,
        accountId: 'acc-1',
        userId: 'usr-1',
      });

      (resolveTemplateRow as any).mockResolvedValue({
        row: {
          name: 'with_btns',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Join Now' },
            { type: 'URL', text: 'Visit Website', url: 'https://example.com' },
          ],
        },
      });

      const req = new NextRequest('http://localhost/api/whatsapp/broadcast/bc-1/buttons');
      const res = await getButtonStats(req, { params: Promise.resolve({ id: 'bc-1' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.hasButtons).toBe(true);
      expect(body.buttons).toHaveLength(2);

      // Button 0 (Quick Reply): 180 / 1000 = 18.0%
      expect(body.buttons[0]).toEqual({
        buttonIndex: 0,
        buttonName: 'Join Now',
        buttonType: 'Quick Reply',
        rawType: 'QUICK_REPLY',
        trackable: true,
        totalClicks: 250,
        uniqueUsers: 180,
        clickPercentage: 18.0,
      });

      // Button 1 (URL): not trackable via webhook
      expect(body.buttons[1]).toEqual({
        buttonIndex: 1,
        buttonName: 'Visit Website',
        buttonType: 'URL',
        rawType: 'URL',
        trackable: false,
        totalClicks: 0,
        uniqueUsers: 0,
        clickPercentage: 0,
      });
    });
  });

  describe('GET /api/whatsapp/broadcast/[id]/buttons/[buttonIndex]/export', () => {
    it('returns 400 for invalid button index', async () => {
      (requireRole as any).mockResolvedValue({
        supabase: {},
        accountId: 'acc-1',
      });

      const req = new NextRequest('http://localhost/api/whatsapp/broadcast/bc-1/buttons/abc/export');
      const res = await exportButtonUsers(req, {
        params: Promise.resolve({ id: 'bc-1', buttonIndex: 'abc' }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Invalid button index parameter');
    });

    it('exports unique users as CSV with deduplicated clicks and correct timestamps', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'broadcasts') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: {
                        id: 'bc-12345678-full',
                        name: 'Special Promo',
                        template_name: 'promo',
                        template_language: 'en_US',
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'broadcast_button_clicks') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      order: vi.fn().mockResolvedValue({
                        data: [
                          {
                            contact_id: 'cnt-1',
                            button_name: 'Join Now',
                            button_type: 'QUICK_REPLY',
                            clicked_at: '2026-10-07T12:00:00Z',
                            contact: {
                              id: 'cnt-1',
                              name: 'John Doe',
                              phone: '+15550100',
                              email: 'john@example.com',
                            },
                          },
                          {
                            contact_id: 'cnt-1',
                            button_name: 'Join Now',
                            button_type: 'QUICK_REPLY',
                            clicked_at: '2026-10-07T12:15:00Z',
                            contact: {
                              id: 'cnt-1',
                              name: 'John Doe',
                              phone: '+15550100',
                              email: 'john@example.com',
                            },
                          },
                          {
                            contact_id: 'cnt-2',
                            button_name: 'Join Now',
                            button_type: 'QUICK_REPLY',
                            clicked_at: '2026-10-07T12:05:00Z',
                            contact: {
                              id: 'cnt-2',
                              name: 'Jane Smith',
                              phone: '+15550200',
                              email: 'jane@example.com',
                            },
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      (requireRole as any).mockResolvedValue({
        supabase: mockSupabase,
        accountId: 'acc-1',
      });

      (resolveTemplateRow as any).mockResolvedValue({
        row: {
          name: 'promo',
          buttons: [{ type: 'QUICK_REPLY', text: 'Join Now' }],
        },
      });

      const req = new NextRequest(
        'http://localhost/api/whatsapp/broadcast/bc-12345678-full/buttons/0/export'
      );
      const res = await exportButtonUsers(req, {
        params: Promise.resolve({ id: 'bc-12345678-full', buttonIndex: '0' }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('Content-Disposition')).toContain(
        'filename="broadcast-bc-12345-join-now-users.csv"'
      );

      const csvText = await res.text();
      const lines = csvText.split('\r\n');

      expect(lines[0]).toBe(
        'Name,Phone,Email,Button Name,Button Type,First Clicked At,Last Clicked At,Total Clicks'
      );

      // Contact 1 clicked twice, collapsed to 1 row with totalClicks: 2
      expect(lines).toHaveLength(3); // Header + 2 unique users
      expect(lines[1]).toContain('John Doe');
      expect(lines[1]).toContain('+15550100');
      expect(lines[1]).toContain('2'); // Total clicks 2
      expect(lines[2]).toContain('Jane Smith');
      expect(lines[2]).toContain('1'); // Total clicks 1
    });

    it('exports unique users for URL button clicks (Method 2)', async () => {
      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'broadcasts') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: {
                        id: 'bc-url-1234',
                        name: 'Website Campaign',
                        template_name: 'website_tmpl',
                        template_language: 'en_US',
                      },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'broadcast_button_clicks') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockReturnValue({
                      order: vi.fn().mockResolvedValue({
                        data: [
                          {
                            contact_id: 'cnt-url-1',
                            button_name: 'Visit Website',
                            button_type: 'URL',
                            clicked_at: '2026-10-09T10:00:00Z',
                            contact: {
                              id: 'cnt-url-1',
                              name: 'Target Customer',
                              phone: '+918075114287',
                              email: 'customer@example.com',
                            },
                          },
                        ],
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        }),
      };

      (requireRole as any).mockResolvedValue({
        supabase: mockSupabase,
        accountId: 'acc-1',
        userId: 'usr-1',
      });

      (resolveTemplateRow as any).mockResolvedValue({
        row: {
          name: 'website_tmpl',
          buttons: [{ type: 'URL', text: 'Visit Website', url: 'https://example.com/r/{{1}}' }],
        },
      });

      const req = new NextRequest(
        'http://localhost/api/whatsapp/broadcast/bc-url-1234/buttons/0/export'
      );
      const res = await exportButtonUsers(req, {
        params: Promise.resolve({ id: 'bc-url-1234', buttonIndex: '0' }),
      });

      expect(res.status).toBe(200);
      const csvText = await res.text();
      const lines = csvText.split('\r\n');

      expect(lines).toHaveLength(2); // Header + 1 user
      expect(lines[1]).toContain('Target Customer');
      expect(lines[1]).toContain('+918075114287');
      expect(lines[1]).toContain('URL');
      expect(lines[1]).toContain('Visit Website');
    });
  });
});
