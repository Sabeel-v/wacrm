import { NextRequest, NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  escapeCsvCell,
  sanitizeCsvFilename,
  humanizeButtonType,
} from '@/lib/whatsapp/broadcast-button-tracking';
import type { MessageTemplate, TemplateButton } from '@/types';

interface ContactClickRow {
  contact_id: string | null;
  button_name: string;
  button_type: string;
  clicked_at: string;
  contact?: {
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
}

/**
 * GET /api/whatsapp/broadcast/[id]/buttons/[buttonIndex]/export
 *
 * Dedicated endpoint for server-side CSV generation of unique users
 * who clicked a specific WhatsApp broadcast template button.
 * Role-gated by requireRole('viewer') as specified.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string; buttonIndex: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { id: broadcastId, buttonIndex: rawButtonIndex } = await context.params;

    const buttonIndex = parseInt(rawButtonIndex, 10);
    if (isNaN(buttonIndex) || buttonIndex < 0) {
      return NextResponse.json(
        { error: 'Invalid button index parameter' },
        { status: 400 }
      );
    }

    // 1. Verify broadcast existence and tenant ownership
    const { data: broadcast, error: bcErr } = await supabase
      .from('broadcasts')
      .select('id, name, template_name, template_language')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (bcErr) {
      return NextResponse.json({ error: bcErr.message }, { status: 500 });
    }
    if (!broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    // 2. Resolve template button info for default naming
    let buttonLabel = `Button ${buttonIndex + 1}`;
    let buttonType = 'QUICK_REPLY';

    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      broadcast.template_name,
      broadcast.template_language
    );

    const templateRow = resolvedTemplate.row as MessageTemplate | null;
    if (templateRow?.buttons && Array.isArray(templateRow.buttons)) {
      const templateButtons = templateRow.buttons as TemplateButton[];
      if (templateButtons[buttonIndex]) {
        buttonLabel = templateButtons[buttonIndex].text || buttonLabel;
        buttonType = templateButtons[buttonIndex].type || buttonType;
      }
    }

    // 3. Query click events for this button joined with contact details
    const { data: rawClicks, error: clicksErr } = await supabase
      .from('broadcast_button_clicks')
      .select(`
        contact_id,
        button_name,
        button_type,
        clicked_at,
        contact:contacts(id, name, phone, email)
      `)
      .eq('account_id', accountId)
      .eq('broadcast_id', broadcastId)
      .eq('button_index', buttonIndex)
      .order('clicked_at', { ascending: true });

    if (clicksErr) {
      return NextResponse.json({ error: clicksErr.message }, { status: 500 });
    }

    const clicks = (rawClicks ?? []) as unknown as ContactClickRow[];

    // Fallback phone lookup from broadcast_url_tokens if contact phone is absent
    const tokenPhoneMap = new Map<string, string>();
    const hasMissingPhone = clicks.some((c) => !c.contact?.phone);
    if (hasMissingPhone) {
      try {
        const { data: urlTokenRows } = await supabase
          .from('broadcast_url_tokens')
          .select('contact_id, recipient_phone')
          .eq('account_id', accountId)
          .eq('broadcast_id', broadcastId)
          .eq('button_index', buttonIndex);

        for (const tr of (urlTokenRows ?? []) as Array<{ contact_id: string | null; recipient_phone: string | null }>) {
          if (tr.contact_id && tr.recipient_phone) {
            tokenPhoneMap.set(tr.contact_id, tr.recipient_phone);
          }
        }
      } catch {
        // Safe fallback if table is omitted in mocks
      }
    }

    // 4. Aggregate to UNIQUE USERS
    // A single contact may have clicked multiple times. We collapse by contact_id
    // to record first/last clicked timestamps and total clicks count.
    interface AggregatedUser {
      name: string;
      phone: string;
      email: string;
      buttonName: string;
      buttonType: string;
      firstClickedAt: string;
      lastClickedAt: string;
      totalClicks: number;
    }

    const userMap = new Map<string, AggregatedUser>();

    for (const c of clicks) {
      // Use contact_id if available, fallback to unique key
      const key = c.contact_id || c.contact?.phone || `anon-${c.clicked_at}`;
      const existing = userMap.get(key);
      const clickedTime = c.clicked_at;

      const name = c.contact?.name ?? '';
      const phone = c.contact?.phone || (c.contact_id ? tokenPhoneMap.get(c.contact_id) : '') || '';
      const email = c.contact?.email ?? '';
      const rowBtnName = c.button_name || buttonLabel;
      const rowBtnType = humanizeButtonType(c.button_type || buttonType);

      if (!existing) {
        userMap.set(key, {
          name,
          phone,
          email,
          buttonName: rowBtnName,
          buttonType: rowBtnType,
          firstClickedAt: clickedTime,
          lastClickedAt: clickedTime,
          totalClicks: 1,
        });
      } else {
        existing.totalClicks += 1;
        if (new Date(clickedTime) > new Date(existing.lastClickedAt)) {
          existing.lastClickedAt = clickedTime;
        }
        if (new Date(clickedTime) < new Date(existing.firstClickedAt)) {
          existing.firstClickedAt = clickedTime;
        }
      }
    }

    const uniqueUsers = Array.from(userMap.values());

    // 5. Build RFC 4180 CSV
    const header = [
      'Name',
      'Phone',
      'Email',
      'Button Name',
      'Button Type',
      'First Clicked At',
      'Last Clicked At',
      'Total Clicks',
    ];

    const lines: string[] = [header.join(',')];

    for (const u of uniqueUsers) {
      lines.push(
        [
          escapeCsvCell(u.name),
          escapeCsvCell(u.phone),
          escapeCsvCell(u.email),
          escapeCsvCell(u.buttonName),
          escapeCsvCell(u.buttonType),
          escapeCsvCell(u.firstClickedAt),
          escapeCsvCell(u.lastClickedAt),
          escapeCsvCell(u.totalClicks),
        ].join(',')
      );
    }

    const csvContent = lines.join('\r\n');
    const filename = sanitizeCsvFilename(broadcastId, buttonLabel);

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
