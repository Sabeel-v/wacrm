import { SupabaseClient } from '@supabase/supabase-js';

export interface NodeLeadItem {
  contact_id: string;
  name: string;
  phone: string;
  flow_id: string;
  flow_name: string;
  node_id: string;
  node_name: string;
  first_reached_at: string;
  last_reached_at: string;
  reach_count: number;
}

export interface NodeLeadsResult {
  data: NodeLeadItem[];
  total: number;
  page: number;
  limit: number;
  flow: {
    id: string;
    name: string;
  };
  node: {
    id: string;
    node_key: string;
    node_name: string;
    node_type: string;
  };
}

export interface NodeLeadsFilter {
  page?: number;
  limit?: number;
  search?: string;
  date_from?: string;
  date_to?: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveNodeDisplayName(nodeKey: string, config: Record<string, unknown> | null): string {
  if (config) {
    if (typeof config.name === 'string' && config.name.trim().length > 0) {
      return config.name.trim();
    }
    if (typeof config.title === 'string' && config.title.trim().length > 0) {
      return config.title.trim();
    }
  }
  return nodeKey;
}

/**
 * Escapes a cell value for standard CSV (RFC 4180).
 */
export function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function fetchFlowNodeLeads(
  supabase: SupabaseClient,
  flowId: string,
  nodeId: string,
  filters: NodeLeadsFilter = {},
): Promise<NodeLeadsResult | { error: string; status: number }> {
  // 1. Confirm flow exists and caller has read access (enforced by RLS)
  const { data: flow, error: flowErr } = await supabase
    .from('flows')
    .select('id, name')
    .eq('id', flowId)
    .maybeSingle();

  if (flowErr) {
    return { error: flowErr.message, status: 500 };
  }
  if (!flow) {
    return { error: 'Flow not found', status: 404 };
  }

  // 2. Resolve node by UUID id OR node_key
  const isUuid = UUID_REGEX.test(nodeId);
  const nodeQuery = supabase
    .from('flow_nodes')
    .select('id, node_key, node_type, config')
    .eq('flow_id', flowId);

  const { data: node, error: nodeErr } = isUuid
    ? await nodeQuery.or(`id.eq.${nodeId},node_key.eq.${nodeId}`).maybeSingle()
    : await nodeQuery.eq('node_key', nodeId).maybeSingle();

  if (nodeErr) {
    return { error: nodeErr.message, status: 500 };
  }
  if (!node) {
    return { error: 'Node not found', status: 404 };
  }

  const nodeName = resolveNodeDisplayName(node.node_key, node.config as Record<string, unknown>);
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.max(1, Math.min(filters.limit ?? 25, 100));
  const offset = (page - 1) * limit;
  const search = filters.search?.trim() ? filters.search.trim() : null;
  const dateFrom = filters.date_from?.trim() ? filters.date_from.trim() : null;
  const dateTo = filters.date_to?.trim() ? filters.date_to.trim() : null;

  // 3. Try performant database-side RPC first
  const { data: rpcData, error: rpcErr } = await supabase.rpc('get_flow_node_leads', {
    p_flow_id: flow.id,
    p_node_key: node.node_key,
    p_search: search,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_limit: limit,
    p_offset: offset,
  });

  if (!rpcErr && Array.isArray(rpcData)) {
    const total = rpcData.length > 0 ? Number(rpcData[0].total_count ?? 0) : 0;
    const items: NodeLeadItem[] = rpcData.map((row: {
      contact_id: string;
      contact_name: string | null;
      contact_phone: string;
      first_reached_at: string;
      last_reached_at: string;
      reach_count: number | string;
    }) => ({
      contact_id: row.contact_id,
      name: row.contact_name ?? '',
      phone: row.contact_phone ?? '',
      flow_id: flow.id,
      flow_name: flow.name,
      node_id: node.id,
      node_name: nodeName,
      first_reached_at: row.first_reached_at,
      last_reached_at: row.last_reached_at,
      reach_count: Number(row.reach_count ?? 1),
    }));

    return {
      data: items,
      total,
      page,
      limit,
      flow: { id: flow.id, name: flow.name },
      node: {
        id: node.id,
        node_key: node.node_key,
        node_name: nodeName,
        node_type: node.node_type,
      },
    };
  }

  // 4. Fallback if RPC is not yet registered (e.g. before migration execution)
  const { data: runs, error: runsErr } = await supabase
    .from('flow_runs')
    .select('id, contact_id')
    .eq('flow_id', flowId)
    .not('contact_id', 'is', null);

  if (runsErr) {
    return { error: runsErr.message, status: 500 };
  }

  const runMap = new Map<string, string>(); // run_id -> contact_id
  for (const r of runs ?? []) {
    if (r.id && r.contact_id) {
      runMap.set(r.id, r.contact_id);
    }
  }

  const runIds = Array.from(runMap.keys());
  if (runIds.length === 0) {
    return {
      data: [],
      total: 0,
      page,
      limit,
      flow: { id: flow.id, name: flow.name },
      node: {
        id: node.id,
        node_key: node.node_key,
        node_name: nodeName,
        node_type: node.node_type,
      },
    };
  }

  let evQuery = supabase
    .from('flow_run_events')
    .select('flow_run_id, created_at')
    .eq('event_type', 'node_entered')
    .eq('node_key', node.node_key)
    .in('flow_run_id', runIds)
    .order('created_at', { ascending: true });

  if (dateFrom) evQuery = evQuery.gte('created_at', dateFrom);
  if (dateTo) evQuery = evQuery.lte('created_at', dateTo);

  const { data: events, error: evErr } = await evQuery;
  if (evErr) {
    return { error: evErr.message, status: 500 };
  }

  // Aggregate by contact_id
  const contactStats = new Map<
    string,
    { first_reached_at: string; last_reached_at: string; count: number }
  >();

  for (const ev of events ?? []) {
    const contactId = runMap.get(ev.flow_run_id);
    if (!contactId) continue;
    const existing = contactStats.get(contactId);
    if (!existing) {
      contactStats.set(contactId, {
        first_reached_at: ev.created_at,
        last_reached_at: ev.created_at,
        count: 1,
      });
    } else {
      existing.last_reached_at = ev.created_at;
      existing.count += 1;
    }
  }

  const uniqueContactIds = Array.from(contactStats.keys());
  if (uniqueContactIds.length === 0) {
    return {
      data: [],
      total: 0,
      page,
      limit,
      flow: { id: flow.id, name: flow.name },
      node: {
        id: node.id,
        node_key: node.node_key,
        node_name: nodeName,
        node_type: node.node_type,
      },
    };
  }

  let contactsQuery = supabase
    .from('contacts')
    .select('id, name, phone')
    .in('id', uniqueContactIds);

  if (search) {
    contactsQuery = contactsQuery.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data: contacts, error: contactsErr } = await contactsQuery;
  if (contactsErr) {
    return { error: contactsErr.message, status: 500 };
  }

  const combined: NodeLeadItem[] = [];
  for (const c of contacts ?? []) {
    const stats = contactStats.get(c.id);
    if (!stats) continue;
    combined.push({
      contact_id: c.id,
      name: c.name ?? '',
      phone: c.phone ?? '',
      flow_id: flow.id,
      flow_name: flow.name,
      node_id: node.id,
      node_name: nodeName,
      first_reached_at: stats.first_reached_at,
      last_reached_at: stats.last_reached_at,
      reach_count: stats.count,
    });
  }

  // Sort by last_reached_at desc
  combined.sort(
    (a, b) => new Date(b.last_reached_at).getTime() - new Date(a.last_reached_at).getTime(),
  );

  const total = combined.length;
  const paged = combined.slice(offset, offset + limit);

  return {
    data: paged,
    total,
    page,
    limit,
    flow: { id: flow.id, name: flow.name },
    node: {
      id: node.id,
      node_key: node.node_key,
      node_name: nodeName,
      node_type: node.node_type,
    },
  };
}

/**
 * Fetches all matching leads for CSV export without pagination.
 */
export async function exportFlowNodeLeads(
  supabase: SupabaseClient,
  flowId: string,
  nodeId: string,
  filters: Omit<NodeLeadsFilter, 'page' | 'limit'> = {},
): Promise<{ csv: string; filename: string } | { error: string; status: number }> {
  // First resolve flow and node
  const { data: flow } = await supabase
    .from('flows')
    .select('id, name')
    .eq('id', flowId)
    .maybeSingle();

  if (!flow) return { error: 'Flow not found', status: 404 };

  const isUuid = UUID_REGEX.test(nodeId);
  const nodeQuery = supabase
    .from('flow_nodes')
    .select('id, node_key, node_type, config')
    .eq('flow_id', flowId);

  const { data: node } = isUuid
    ? await nodeQuery.or(`id.eq.${nodeId},node_key.eq.${nodeId}`).maybeSingle()
    : await nodeQuery.eq('node_key', nodeId).maybeSingle();

  if (!node) return { error: 'Node not found', status: 404 };

  const nodeName = resolveNodeDisplayName(node.node_key, node.config as Record<string, unknown>);
  const search = filters.search?.trim() ? filters.search.trim() : null;
  const dateFrom = filters.date_from?.trim() ? filters.date_from.trim() : null;
  const dateTo = filters.date_to?.trim() ? filters.date_to.trim() : null;

  // Try RPC with no limit
  let rows: Array<{
    phone: string;
    name: string;
    flow_name: string;
    node_name: string;
    first_reached_at: string;
    last_reached_at: string;
    reach_count: number;
  }> = [];

  const { data: rpcData, error: rpcErr } = await supabase.rpc('get_flow_node_leads', {
    p_flow_id: flow.id,
    p_node_key: node.node_key,
    p_search: search,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_limit: null,
    p_offset: 0,
  });

  if (!rpcErr && Array.isArray(rpcData)) {
    rows = rpcData.map((r: {
      contact_phone: string;
      contact_name: string | null;
      first_reached_at: string;
      last_reached_at: string;
      reach_count: number | string;
    }) => ({
      phone: r.contact_phone ?? '',
      name: r.contact_name ?? '',
      flow_name: flow.name,
      node_name: nodeName,
      first_reached_at: r.first_reached_at,
      last_reached_at: r.last_reached_at,
      reach_count: Number(r.reach_count ?? 1),
    }));
  } else {
    // Fallback: fetch page with high limit
    const fallback = await fetchFlowNodeLeads(supabase, flowId, nodeId, {
      ...filters,
      page: 1,
      limit: 10000,
    });
    if ('error' in fallback) return fallback;
    rows = fallback.data.map((d) => ({
      phone: d.phone,
      name: d.name,
      flow_name: d.flow_name,
      node_name: d.node_name,
      first_reached_at: d.first_reached_at,
      last_reached_at: d.last_reached_at,
      reach_count: d.reach_count,
    }));
  }

  // Generate CSV according to exact requirements:
  // phone,name,flow_name,node_name,first_reached_at,last_reached_at,reach_count
  const header = ['phone', 'name', 'flow_name', 'node_name', 'first_reached_at', 'last_reached_at', 'reach_count'];
  const csvLines = [header.join(',')];

  for (const r of rows) {
    csvLines.push([
      escapeCsvCell(r.phone),
      escapeCsvCell(r.name),
      escapeCsvCell(r.flow_name),
      escapeCsvCell(r.node_name),
      escapeCsvCell(r.first_reached_at),
      escapeCsvCell(r.last_reached_at),
      escapeCsvCell(r.reach_count),
    ].join(','));
  }

  const csv = csvLines.join('\r\n');
  const safeNodeName = node.node_key.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `flow-node-leads-${safeNodeName}.csv`;

  return { csv, filename };
}
