import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { exportFlowNodeLeads, fetchFlowNodeLeads } from '@/lib/flows/node-leads';

/**
 * GET /api/flows/[id]/nodes/[nodeId]/leads
 *
 * Returns contacts who reached a specific flow node, along with
 * their first reached time, last reached time, and reach count.
 * Supports pagination, search (phone & name), and date filtering.
 *
 * If `export=csv` query parameter is provided, returns CSV file directly.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; nodeId: string }> },
) {
  const { id: flowId, nodeId } = await context.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const isExport = searchParams.get('export') === 'csv';
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1;
  const limit = parseInt(searchParams.get('limit') ?? '25', 10) || 25;
  const search = searchParams.get('search') ?? undefined;
  const dateFrom = searchParams.get('date_from') ?? undefined;
  const dateTo = searchParams.get('date_to') ?? undefined;

  if (isExport) {
    const exportResult = await exportFlowNodeLeads(supabase, flowId, nodeId, {
      search,
      date_from: dateFrom,
      date_to: dateTo,
    });

    if ('error' in exportResult) {
      return NextResponse.json({ error: exportResult.error }, { status: exportResult.status });
    }

    return new NextResponse(exportResult.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportResult.filename}"`,
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  }

  const result = await fetchFlowNodeLeads(supabase, flowId, nodeId, {
    page,
    limit,
    search,
    date_from: dateFrom,
    date_to: dateTo,
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
