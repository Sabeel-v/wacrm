import { NextRequest, NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  humanizeButtonType,
  isButtonTrackable,
  calculateClickPercentage,
} from '@/lib/whatsapp/broadcast-button-tracking';
import type { MessageTemplate, TemplateButton } from '@/types';

/**
 * GET /api/whatsapp/broadcast/[id]/buttons
 *
 * Fetches button analytics for a broadcast.
 * Scoped to the caller's account via requireRole('viewer').
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { id: broadcastId } = await context.params;

    // 1. Fetch broadcast row
    const { data: broadcast, error: bcErr } = await supabase
      .from('broadcasts')
      .select('id, name, template_name, template_language, delivered_count, sent_count')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (bcErr) {
      return NextResponse.json({ error: bcErr.message }, { status: 500 });
    }
    if (!broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    // 2. Resolve template to inspect its buttons
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      broadcast.template_name,
      broadcast.template_language
    );

    const templateRow = resolvedTemplate.row as MessageTemplate | null;
    const rawButtons = (templateRow?.buttons ?? []) as TemplateButton[];

    if (!rawButtons || rawButtons.length === 0) {
      return NextResponse.json({
        hasButtons: false,
        buttons: [],
      });
    }

    // 3. Fetch aggregated button clicks for this broadcast
    const statsMap = new Map<number, { totalClicks: number; uniqueUsers: number }>();

    // Try DB aggregation RPC first
    const { data: rpcData, error: rpcErr } = await supabase.rpc(
      'get_broadcast_button_analytics',
      {
        p_account_id: accountId,
        p_broadcast_id: broadcastId,
      }
    );

    if (!rpcErr && Array.isArray(rpcData)) {
      for (const row of rpcData) {
        statsMap.set(Number(row.button_index), {
          totalClicks: Number(row.total_clicks ?? 0),
          uniqueUsers: Number(row.unique_users ?? 0),
        });
      }
    } else {
      // Fallback: direct aggregate query
      const { data: clicks } = await supabase
        .from('broadcast_button_clicks')
        .select('button_index, contact_id')
        .eq('account_id', accountId)
        .eq('broadcast_id', broadcastId);

      if (clicks && clicks.length > 0) {
        const userSets = new Map<number, Set<string>>();
        const clickCounts = new Map<number, number>();

        for (const c of clicks) {
          const idx = Number(c.button_index);
          clickCounts.set(idx, (clickCounts.get(idx) ?? 0) + 1);
          if (c.contact_id) {
            const set = userSets.get(idx) ?? new Set<string>();
            set.add(c.contact_id);
            userSets.set(idx, set);
          }
        }

        for (const [idx, count] of clickCounts.entries()) {
          statsMap.set(idx, {
            totalClicks: count,
            uniqueUsers: userSets.get(idx)?.size ?? 0,
          });
        }
      }
    }

    // Check if any tracking tokens exist for buttons in this broadcast
    const { data: tokenRows } = await supabase
      .from('broadcast_url_tokens')
      .select('button_index')
      .eq('account_id', accountId)
      .eq('broadcast_id', broadcastId);

    const tokenButtonIndices = new Set(
      (tokenRows ?? []).map((r: { button_index: number }) => Number(r.button_index))
    );

    // 4. Assemble final stats for each button
    const buttons = rawButtons.map((btn, index) => {
      const stat = statsMap.get(index) ?? { totalClicks: 0, uniqueUsers: 0 };
      const buttonUrl = btn.type === 'URL' ? btn.url : undefined;
      const trackable = isButtonTrackable(btn.type, {
        url: buttonUrl,
        totalClicks: stat.totalClicks,
        hasTokens: tokenButtonIndices.has(index),
      });
      const totalClicks = trackable ? stat.totalClicks : 0;
      const uniqueUsers = trackable ? stat.uniqueUsers : 0;
      const clickPercentage = trackable
        ? calculateClickPercentage(uniqueUsers, broadcast.delivered_count ?? 0)
        : 0;

      return {
        buttonIndex: index,
        buttonName: btn.text,
        buttonType: humanizeButtonType(btn.type),
        rawType: btn.type,
        trackable,
        totalClicks,
        uniqueUsers,
        clickPercentage,
      };
    });

    return NextResponse.json({
      hasButtons: true,
      buttons,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
