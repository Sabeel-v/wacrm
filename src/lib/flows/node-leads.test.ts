import { describe, it, expect, vi } from 'vitest';
import {
  fetchFlowNodeLeads,
  exportFlowNodeLeads,
  escapeCsvCell,
  resolveNodeDisplayName,
} from './node-leads';
import { matchReplyId } from './engine';

describe('escapeCsvCell', () => {
  it('escapes cells containing commas, quotes, and newlines', () => {
    expect(escapeCsvCell('Hello, World')).toBe('"Hello, World"');
    expect(escapeCsvCell('He said "Hi"')).toBe('"He said ""Hi"""');
    expect(escapeCsvCell('Line1\nLine2')).toBe('"Line1\nLine2"');
    expect(escapeCsvCell('+919876543210')).toBe('+919876543210');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell(42)).toBe('42');
  });
});

describe('resolveNodeDisplayName', () => {
  it('uses config.name or config.title if present, else nodeKey', () => {
    expect(resolveNodeDisplayName('ai_film_making', { name: 'AI FILM MAKING' })).toBe(
      'AI FILM MAKING',
    );
    expect(resolveNodeDisplayName('ai_film_making', { title: 'AI Film Making Course' })).toBe(
      'AI Film Making Course',
    );
    expect(resolveNodeDisplayName('ai_film_making', {})).toBe('ai_film_making');
    expect(resolveNodeDisplayName('ai_film_making', null)).toBe('ai_film_making');
  });
});

describe('Flow Node Lead Tracking & CSV Export', () => {
  // Build a flexible mock Supabase client
  function createMockSupabase(initialData: {
    flow?: { id: string; name: string } | null;
    nodes?: Array<{ id: string; flow_id: string; node_key: string; node_type: string; config: Record<string, unknown> }>;
    runs?: Array<{ id: string; flow_id: string; contact_id: string }>;
    events?: Array<{ id: string; flow_run_id: string; node_key: string; event_type: string; created_at: string }>;
    contacts?: Array<{ id: string; name: string | null; phone: string; tags?: string[] }>;
    rpcResult?: unknown[] | null;
  }) {
    const {
      flow = { id: 'flow-1', name: 'Course Selection' },
      nodes = [
        {
          id: 'node-uuid-1',
          flow_id: 'flow-1',
          node_key: 'ai_film_making',
          node_type: 'set_tag',
          config: { name: 'AI FILM MAKING' },
        },
        {
          id: 'node-uuid-2',
          flow_id: 'flow-1',
          node_key: 'data_analytics',
          node_type: 'send_message',
          config: { name: 'DATA ANALYTICS' },
        },
      ],
      runs = [],
      events = [],
      contacts = [],
      rpcResult = null,
    } = initialData;

    const client: any = {
      from: (table: string) => {
        let selectedFields = '*';
        let filters: Array<(row: any) => boolean> = [];
        let orderField: string | null = null;
        let orderAsc = true;

        const builder: any = {
          select: (fields: string) => {
            selectedFields = fields;
            return builder;
          },
          eq: (field: string, val: any) => {
            filters.push((row: any) => row[field] === val);
            return builder;
          },
          not: (field: string, op: string, val: any) => {
            if (op === 'is' && val === null) {
              filters.push((row: any) => row[field] !== null && row[field] !== undefined);
            }
            return builder;
          },
          in: (field: string, vals: any[]) => {
            filters.push((row: any) => vals.includes(row[field]));
            return builder;
          },
          gte: (field: string, val: any) => {
            filters.push((row: any) => new Date(row[field]) >= new Date(val));
            return builder;
          },
          lte: (field: string, val: any) => {
            filters.push((row: any) => new Date(row[field]) <= new Date(val));
            return builder;
          },
          or: (conditionStr: string) => {
            // Very simple parser for conditions like name.ilike.%x%,phone.ilike.%x% or id.eq.x,node_key.eq.x
            const parts = conditionStr.split(',');
            filters.push((row: any) => {
              return parts.some((p) => {
                const [f, op, rawV] = p.split('.');
                if (op === 'eq') return row[f] === rawV;
                if (op === 'ilike') {
                  const searchPattern = rawV.replace(/%/g, '').toLowerCase();
                  return String(row[f] ?? '').toLowerCase().includes(searchPattern);
                }
                return false;
              });
            });
            return builder;
          },
          order: (field: string, opts?: { ascending?: boolean }) => {
            orderField = field;
            orderAsc = opts?.ascending ?? true;
            return builder;
          },
          maybeSingle: async () => {
            const tableRows =
              table === 'flows'
                ? (flow ? [flow] : [])
                : table === 'flow_nodes'
                ? nodes
                : table === 'flow_runs'
                ? runs
                : table === 'flow_run_events'
                ? events
                : contacts;

            const filtered = tableRows.filter((r) => filters.every((fn) => fn(r)));
            return { data: filtered[0] ?? null, error: null };
          },
          then: (resolve: (res: { data: any[]; error: null }) => void) => {
            const tableRows =
              table === 'flows'
                ? (flow ? [flow] : [])
                : table === 'flow_nodes'
                ? nodes
                : table === 'flow_runs'
                ? runs
                : table === 'flow_run_events'
                ? events
                : contacts;

            let filtered = tableRows.filter((r) => filters.every((fn) => fn(r)));
            if (orderField) {
              filtered.sort((a: any, b: any) => {
                const av = a[orderField!];
                const bv = b[orderField!];
                return orderAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
              });
            }
            resolve({ data: filtered, error: null });
          },
        };

        return builder;
      },
      rpc: vi.fn(async (fnName: string, args: any) => {
        if (rpcResult !== null) {
          return { data: rpcResult, error: null };
        }
        // If null, simulate RPC not installed so fallback executes
        return { data: null, error: { message: 'function does not exist', code: '42883' } };
      }),
    };

    return client;
  }

  // 1. Contact reaches AI FILM MAKING once
  it('1. tracks a contact who reached AI FILM MAKING once', async () => {
    const supabase = createMockSupabase({
      contacts: [{ id: 'c-1', name: 'Rahul', phone: '+919876543210' }],
      runs: [{ id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' }],
      events: [
        {
          id: 'ev-1',
          flow_run_id: 'run-1',
          node_key: 'ai_film_making',
          event_type: 'node_entered',
          created_at: '2026-10-06T10:32:15Z',
        },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making');
    expect('error' in res).toBe(false);
    if ('error' in res) return;

    expect(res.total).toBe(1);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({
      contact_id: 'c-1',
      name: 'Rahul',
      phone: '+919876543210',
      flow_name: 'Course Selection',
      node_name: 'AI FILM MAKING',
      first_reached_at: '2026-10-06T10:32:15Z',
      last_reached_at: '2026-10-06T10:32:15Z',
      reach_count: 1,
    });
  });

  // 2. Contact reaches AI FILM MAKING twice
  it('2. tracks a contact reaching AI FILM MAKING twice with first and last timestamps and count=2', async () => {
    const supabase = createMockSupabase({
      contacts: [{ id: 'c-1', name: 'Rahul', phone: '+919876543210' }],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-1' },
      ],
      events: [
        {
          id: 'ev-1',
          flow_run_id: 'run-1',
          node_key: 'ai_film_making',
          event_type: 'node_entered',
          created_at: '2026-10-06T10:32:15Z',
        },
        {
          id: 'ev-2',
          flow_run_id: 'run-2',
          node_key: 'ai_film_making',
          event_type: 'node_entered',
          created_at: '2026-10-08T14:15:22Z',
        },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making');
    expect('error' in res).toBe(false);
    if ('error' in res) return;

    expect(res.total).toBe(1);
    expect(res.data[0].reach_count).toBe(2);
    expect(res.data[0].first_reached_at).toBe('2026-10-06T10:32:15Z');
    expect(res.data[0].last_reached_at).toBe('2026-10-08T14:15:22Z');
  });

  // 3. Same contact reaches another node
  it('3. isolates nodes: contact reaching data_analytics does NOT appear under ai_film_making', async () => {
    const supabase = createMockSupabase({
      contacts: [{ id: 'c-1', name: 'Rahul', phone: '+919876543210' }],
      runs: [{ id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' }],
      events: [
        {
          id: 'ev-1',
          flow_run_id: 'run-1',
          node_key: 'data_analytics',
          event_type: 'node_entered',
          created_at: '2026-10-06T11:00:00Z',
        },
      ],
    });

    const aiFilmRes = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making');
    expect('error' in aiFilmRes).toBe(false);
    if ('error' in aiFilmRes) return;
    expect(aiFilmRes.total).toBe(0);

    const dataAnalyticsRes = await fetchFlowNodeLeads(supabase, 'flow-1', 'data_analytics');
    expect('error' in dataAnalyticsRes).toBe(false);
    if ('error' in dataAnalyticsRes) return;
    expect(dataAnalyticsRes.total).toBe(1);
    expect(dataAnalyticsRes.data[0].node_name).toBe('DATA ANALYTICS');
  });

  // 4. Multiple contacts reach the same node
  it('4. tracks multiple contacts reaching the same node', async () => {
    const supabase = createMockSupabase({
      contacts: [
        { id: 'c-1', name: 'Rahul', phone: '+919876543210' },
        { id: 'c-2', name: 'Ameen', phone: '+919812345678' },
        { id: 'c-3', name: 'Fathima', phone: '+919923456789' },
      ],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-2' },
        { id: 'run-3', flow_id: 'flow-1', contact_id: 'c-3' },
      ],
      events: [
        { id: 'ev-1', flow_run_id: 'run-1', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:32:00Z' },
        { id: 'ev-2', flow_run_id: 'run-2', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:41:00Z' },
        { id: 'ev-3', flow_run_id: 'run-3', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T11:05:00Z' },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making');
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.total).toBe(3);
    expect(res.data.map((d) => d.name)).toEqual(['Fathima', 'Ameen', 'Rahul']); // sorted by last_reached_at desc
  });

  // 5 & 6. Contact has a tag vs Contact does not have a tag
  it('5 & 6. tracks leads based on Flow execution events regardless of tag presence', async () => {
    const supabase = createMockSupabase({
      contacts: [
        { id: 'c-1', name: 'Tagged Lead', phone: '+919876543210', tags: ['ai_course'] },
        { id: 'c-2', name: 'Untagged Lead', phone: '+919812345678', tags: [] },
      ],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-2' },
      ],
      events: [
        { id: 'ev-1', flow_run_id: 'run-1', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:32:00Z' },
        { id: 'ev-2', flow_run_id: 'run-2', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:41:00Z' },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making');
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.total).toBe(2);
    expect(res.data.some((d) => d.name === 'Tagged Lead')).toBe(true);
    expect(res.data.some((d) => d.name === 'Untagged Lead')).toBe(true);
  });

  // 7. Search by phone
  it('7. filters node leads by phone number', async () => {
    const supabase = createMockSupabase({
      contacts: [
        { id: 'c-1', name: 'Rahul', phone: '+919876543210' },
        { id: 'c-2', name: 'Ameen', phone: '+919812345678' },
      ],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-2' },
      ],
      events: [
        { id: 'ev-1', flow_run_id: 'run-1', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:32:00Z' },
        { id: 'ev-2', flow_run_id: 'run-2', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:41:00Z' },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making', { search: '981234' });
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.total).toBe(1);
    expect(res.data[0].phone).toBe('+919812345678');
    expect(res.data[0].name).toBe('Ameen');
  });

  // 8. Search by name
  it('8. filters node leads by contact name', async () => {
    const supabase = createMockSupabase({
      contacts: [
        { id: 'c-1', name: 'Rahul', phone: '+919876543210' },
        { id: 'c-2', name: 'Ameen', phone: '+919812345678' },
      ],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-2' },
      ],
      events: [
        { id: 'ev-1', flow_run_id: 'run-1', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:32:00Z' },
        { id: 'ev-2', flow_run_id: 'run-2', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:41:00Z' },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making', { search: 'rahul' });
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.total).toBe(1);
    expect(res.data[0].name).toBe('Rahul');
  });

  // 9. Date filtering
  it('9. filters node leads by date range', async () => {
    const supabase = createMockSupabase({
      contacts: [
        { id: 'c-1', name: 'Past Lead', phone: '+919876543210' },
        { id: 'c-2', name: 'Recent Lead', phone: '+919812345678' },
      ],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-2' },
      ],
      events: [
        { id: 'ev-1', flow_run_id: 'run-1', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-09-01T10:00:00Z' },
        { id: 'ev-2', flow_run_id: 'run-2', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:00:00Z' },
      ],
    });

    const res = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making', {
      date_from: '2026-10-01T00:00:00Z',
      date_to: '2026-10-07T00:00:00Z',
    });
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.total).toBe(1);
    expect(res.data[0].name).toBe('Recent Lead');
  });

  // 10. CSV export
  it('10. exports CSV formatted with exact required columns and respects filters', async () => {
    const supabase = createMockSupabase({
      contacts: [
        { id: 'c-1', name: 'Rahul', phone: '+919876543210' },
        { id: 'c-2', name: 'Ameen', phone: '+919812345678' },
      ],
      runs: [
        { id: 'run-1', flow_id: 'flow-1', contact_id: 'c-1' },
        { id: 'run-2', flow_id: 'flow-1', contact_id: 'c-2' },
      ],
      events: [
        { id: 'ev-1', flow_run_id: 'run-1', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:32:15Z' },
        { id: 'ev-2', flow_run_id: 'run-2', node_key: 'ai_film_making', event_type: 'node_entered', created_at: '2026-10-06T10:41:03Z' },
      ],
    });

    const exportResult = await exportFlowNodeLeads(supabase, 'flow-1', 'ai_film_making');
    expect('error' in exportResult).toBe(false);
    if ('error' in exportResult) return;

    expect(exportResult.filename).toBe('flow-node-leads-ai_film_making.csv');
    const lines = exportResult.csv.split('\r\n');
    expect(lines[0]).toBe('phone,name,flow_name,node_name,first_reached_at,last_reached_at,reach_count');
    expect(lines[1]).toContain('+919812345678,Ameen,Course Selection,AI FILM MAKING,2026-10-06T10:41:03Z,2026-10-06T10:41:03Z,1');
    expect(lines[2]).toContain('+919876543210,Rahul,Course Selection,AI FILM MAKING,2026-10-06T10:32:15Z,2026-10-06T10:32:15Z,1');
  });

  // 11. Pagination
  it('11. respects pagination page and limit', async () => {
    const contacts = Array.from({ length: 5 }, (_, i) => ({
      id: `c-${i}`,
      name: `Contact ${i}`,
      phone: `+91980000000${i}`,
    }));
    const runs = contacts.map((c) => ({
      id: `run-${c.id}`,
      flow_id: 'flow-1',
      contact_id: c.id,
    }));
    const events = runs.map((r, i) => ({
      id: `ev-${i}`,
      flow_run_id: r.id,
      node_key: 'ai_film_making',
      event_type: 'node_entered',
      created_at: `2026-10-06T10:0${i}:00Z`,
    }));

    const supabase = createMockSupabase({ contacts, runs, events });

    const page1 = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making', { page: 1, limit: 2 });
    expect('error' in page1).toBe(false);
    if ('error' in page1) return;
    expect(page1.total).toBe(5);
    expect(page1.data).toHaveLength(2);
    expect(page1.page).toBe(1);

    const page2 = await fetchFlowNodeLeads(supabase, 'flow-1', 'ai_film_making', { page: 2, limit: 2 });
    expect('error' in page2).toBe(false);
    if ('error' in page2) return;
    expect(page2.data).toHaveLength(2);
    expect(page2.page).toBe(2);
  });

  // 12. Unauthorized user cannot access another user's flow
  it('12. returns 404 when flow does not exist or caller cannot access it', async () => {
    const supabase = createMockSupabase({ flow: null });
    const res = await fetchFlowNodeLeads(supabase, 'forbidden-flow', 'ai_film_making');
    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.status).toBe(404);
      expect(res.error).toBe('Flow not found');
    }
  });

  // 13. Existing Flow execution WhatsApp list selection routing to node
  it('13. matches WhatsApp list option to target node for execution', () => {
    const sendListNode = {
      node_type: 'send_list' as const,
      config: {
        text: 'Select your course:',
        button_label: 'View Courses',
        sections: [
          {
            title: 'Design & Media',
            rows: [
              { reply_id: 'digital_marketing', title: 'DIGITAL MARKETING', next_node_key: 'dm_node' },
              { reply_id: 'graphic_design', title: 'GRAPHIC DESIGN', next_node_key: 'gd_node' },
              { reply_id: 'video_editing', title: 'VIDEO EDITING', next_node_key: 've_node' },
              { reply_id: 'ai_film_making', title: 'AI FILM MAKING', next_node_key: 'ai_film_making' },
              { reply_id: 'data_analytics', title: 'DATA ANALYTICS', next_node_key: 'data_analytics' },
              { reply_id: 'ai_content', title: 'AI CONTENT', next_node_key: 'ai_content_node' },
            ],
          },
        ],
      },
    };

    // Customer selects "AI FILM MAKING"
    const nextKey = matchReplyId(sendListNode, 'ai_film_making');
    expect(nextKey).toBe('ai_film_making');
  });
});
