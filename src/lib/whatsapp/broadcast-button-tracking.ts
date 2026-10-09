// ============================================================
// Broadcast Button Tracking Service
//
// Strictly additive correlation and tracking for WhatsApp broadcast
// template button clicks.
//
// Rules enforced:
//   1. Button clicks are attributed ONLY when message.context.id exactly
//      matches broadcast_recipients.whatsapp_message_id.
//   2. Webhook idempotency via unique inbound_message_id.
//   3. Never throws; completely decoupled from standard webhook processing.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate, TemplateButton } from '@/types';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { extractVariableIndices } from './template-validators';

export interface WhatsAppButtonMessageLike {
  id: string;
  type: string;
  timestamp: string;
  button?: { text?: string; payload?: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  context?: { id: string };
}

/**
 * Check if the incoming message is a button reply.
 */
export function isButtonMessage(message: WhatsAppButtonMessageLike): boolean {
  if (message.type === 'button' && message.button) return true;
  if (
    message.type === 'interactive' &&
    message.interactive?.type === 'button_reply' &&
    message.interactive.button_reply
  ) {
    return true;
  }
  return false;
}

/**
 * Extract label and payload from button/interactive message.
 */
export function extractButtonDetails(message: WhatsAppButtonMessageLike): {
  label: string | null;
  payload: string | null;
} {
  if (message.type === 'button' && message.button) {
    return {
      label: message.button.text || null,
      payload: message.button.payload || null,
    };
  }
  if (
    message.type === 'interactive' &&
    message.interactive?.type === 'button_reply' &&
    message.interactive.button_reply
  ) {
    return {
      label: message.interactive.button_reply.title || null,
      payload: message.interactive.button_reply.id || null,
    };
  }
  return { label: null, payload: null };
}

/**
 * Returns human-readable label for a button type.
 */
export function humanizeButtonType(type: string): string {
  switch (type?.toUpperCase()) {
    case 'QUICK_REPLY':
      return 'Quick Reply';
    case 'URL':
      return 'URL';
    case 'PHONE_NUMBER':
      return 'Phone Number';
    case 'COPY_CODE':
      return 'Copy Code';
    default:
      return type || 'Quick Reply';
  }
}

/**
 * Generate a short, URL-safe tracking token for dynamic URL button clicks.
 * Safe for Meta WhatsApp Cloud API button parameter constraints (no spaces or special chars).
 */
export function generateTrackingToken(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let token = 't';
  for (let i = 0; i < 9; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export interface IsButtonTrackableOptions {
  url?: string;
  totalClicks?: number;
  hasTokens?: boolean;
}

/**
 * Quick Reply buttons and URL buttons are trackable.
 * - Quick Reply buttons: tracked via inbound WhatsApp webhooks.
 * - URL buttons: tracked via URL redirect tracking (/r/[token]).
 * Phone Number and Copy Code buttons are device-native and not trackable.
 */
export function isButtonTrackable(
  type: string,
  _options?: IsButtonTrackableOptions
): boolean {
  const upper = type?.toUpperCase();
  return upper === 'QUICK_REPLY' || upper === 'URL';
}

/**
 * Record a URL redirect click from /r/[token] and return the destination URL.
 * Never throws; strictly decoupled and safe.
 */
export async function recordBroadcastUrlClick(
  db: SupabaseClient,
  token: string
): Promise<{ destinationUrl: string | null; error?: string }> {
  try {
    const { data: tokenRow, error: tokenErr } = await db
      .from('broadcast_url_tokens')
      .select('id, account_id, broadcast_id, contact_id, button_index, button_name, destination_url')
      .eq('token', token)
      .maybeSingle();

    if (tokenErr || !tokenRow) {
      return { destinationUrl: null, error: tokenErr?.message || 'Token not found' };
    }

    const clickId = `url_${token}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    await db
      .from('broadcast_button_clicks')
      .insert({
        account_id: tokenRow.account_id,
        broadcast_id: tokenRow.broadcast_id,
        contact_id: tokenRow.contact_id,
        button_index: tokenRow.button_index,
        button_name: tokenRow.button_name,
        button_type: 'URL',
        button_payload: tokenRow.destination_url,
        inbound_message_id: clickId,
        clicked_at: new Date().toISOString(),
      });

    return { destinationUrl: tokenRow.destination_url };
  } catch (err) {
    console.error('[broadcast-button-tracking] Failed to record URL click:', err);
    return {
      destinationUrl: null,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Calculate click percentage using delivered_count as the denominator.
 * Avoids NaN / division by zero. Formats to 1 decimal place.
 */
export function calculateClickPercentage(
  uniqueUsers: number,
  deliveredCount: number
): number {
  if (!deliveredCount || deliveredCount <= 0 || !uniqueUsers || uniqueUsers <= 0) {
    return 0;
  }
  const pct = (uniqueUsers / deliveredCount) * 100;
  return Math.round(pct * 10) / 10;
}

/**
 * RFC 4180 CSV cell escaping.
 */
export function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Sanitize button name for a safe CSV download filename.
 */
export function sanitizeCsvFilename(
  broadcastId: string,
  buttonName: string
): string {
  const safeName = buttonName
    .replace(/[^a-z0-9_-]+/gi, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '') || 'button';
  return `broadcast-${broadcastId.slice(0, 8)}-${safeName}-users.csv`;
}

/**
 * Records a button click in `broadcast_button_clicks` if and only if:
 * 1. The message is a button response (`type === 'button'` or `interactive: button_reply`).
 * 2. `message.context?.id` is provided and EXACTLY matches a `broadcast_recipients.whatsapp_message_id`.
 *
 * If no exact match exists, skips button tracking and returns cleanly.
 * Wrapped in try/catch — errors are logged and never re-thrown.
 */
export async function recordBroadcastButtonClickIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  message: WhatsAppButtonMessageLike
): Promise<void> {
  try {
    if (!isButtonMessage(message)) return;

    const parentMessageId = message.context?.id?.trim();
    if (!parentMessageId) {
      // Per requirements: only attribute when context.id exactly matches.
      return;
    }

    const { label, payload } = extractButtonDetails(message);
    const buttonText = label || payload || 'Button';

    // 1. Look up recipient by exact whatsapp_message_id
    const { data: recipient, error: recErr } = await db
      .from('broadcast_recipients')
      .select('id, broadcast_id, broadcasts!inner(id, account_id, template_name, template_language)')
      .eq('whatsapp_message_id', parentMessageId)
      .maybeSingle();

    if (recErr) {
      console.error(
        '[broadcast-button-tracking] recipient lookup error:',
        recErr.message
      );
      return;
    }

    if (!recipient || !recipient.broadcasts) {
      // Not a broadcast template message
      return;
    }

    const broadcast = recipient.broadcasts as unknown as {
      id: string;
      account_id: string;
      template_name: string;
      template_language: string;
    };

    // Ensure tenant isolation
    if (broadcast.account_id !== accountId) {
      return;
    }

    // 2. Resolve template to find button index and type
    let matchedIndex = 0;
    let buttonType = 'QUICK_REPLY';
    let buttonName = buttonText;

    if (broadcast.template_name) {
      const resolved = await resolveTemplateRow(
        db,
        accountId,
        broadcast.template_name,
        broadcast.template_language
      );

      const templateRow = resolved.row as MessageTemplate | null;
      if (templateRow?.buttons && Array.isArray(templateRow.buttons)) {
        const buttons = templateRow.buttons as TemplateButton[];
        const targetClean = buttonText.trim().toLowerCase();

        const foundIdx = buttons.findIndex((b) => {
          if (b.text && b.text.trim().toLowerCase() === targetClean) return true;
          if (payload && b.text && b.text.trim().toLowerCase() === payload.trim().toLowerCase()) return true;
          return false;
        });

        if (foundIdx >= 0) {
          matchedIndex = foundIdx;
          buttonType = buttons[foundIdx].type || 'QUICK_REPLY';
          buttonName = buttons[foundIdx].text || buttonName;
        }
      }
    }

    // Parse click timestamp safely
    const tsSec = parseInt(message.timestamp, 10);
    const clickedAt =
      !isNaN(tsSec) && tsSec > 0
        ? new Date(tsSec * 1000).toISOString()
        : new Date().toISOString();

    // 3. Idempotently insert click record
    const { error: insertErr } = await db
      .from('broadcast_button_clicks')
      .upsert(
        {
          account_id: accountId,
          broadcast_id: recipient.broadcast_id,
          contact_id: contactId,
          button_index: matchedIndex,
          button_name: buttonName,
          button_type: buttonType,
          button_payload: payload,
          inbound_message_id: message.id,
          clicked_at: clickedAt,
        },
        { onConflict: 'inbound_message_id', ignoreDuplicates: true }
      );

    if (insertErr) {
      console.error(
        '[broadcast-button-tracking] click insert error:',
        insertErr.message
      );
    }
  } catch (err) {
    console.error(
      '[broadcast-button-tracking] recordBroadcastButtonClickIfAny threw:',
      err
    );
  }
}
