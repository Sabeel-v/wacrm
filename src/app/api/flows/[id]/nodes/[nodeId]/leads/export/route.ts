import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { exportFlowNodeLeads } from '@/lib/flows/node-leads';

/**
 * GET /api/flows/[id]/nodes/[nodeId]/leads/export
 *
 * Dedicated endpoint for streaming/downloading CSV of node leads.
 * Respects the same search and date filters.
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
  const search = searchParams.get('search') ?? undefined;
  const dateFrom = searchParams.get('date_from') ?? undefined;
  const dateTo = searchParams.get('date_to') ?? undefined;

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
