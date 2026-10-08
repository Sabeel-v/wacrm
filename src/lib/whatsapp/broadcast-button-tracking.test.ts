import { describe, it, expect, vi } from 'vitest';
import {
  humanizeButtonType,
  isButtonTrackable,
  calculateClickPercentage,
  sanitizeCsvFilename,
  escapeCsvCell,
  isButtonMessage,
  extractButtonDetails,
  recordBroadcastButtonClickIfAny,
  type WhatsAppButtonMessageLike,
} from './broadcast-button-tracking';

describe('broadcast-button-tracking helper functions', () => {
  it('humanizeButtonType returns readable labels', () => {
    expect(humanizeButtonType('QUICK_REPLY')).toBe('Quick Reply');
    expect(humanizeButtonType('URL')).toBe('URL');
    expect(humanizeButtonType('PHONE_NUMBER')).toBe('Phone Number');
    expect(humanizeButtonType('COPY_CODE')).toBe('Copy Code');
    expect(humanizeButtonType('other')).toBe('other');
  });

  it('isButtonTrackable marks only quick replies as trackable via webhook', () => {
    expect(isButtonTrackable('QUICK_REPLY')).toBe(true);
    expect(isButtonTrackable('quick_reply')).toBe(true);
    expect(isButtonTrackable('URL')).toBe(false);
    expect(isButtonTrackable('PHONE_NUMBER')).toBe(false);
    expect(isButtonTrackable('COPY_CODE')).toBe(false);
  });

  it('calculateClickPercentage uses delivered_count as denominator', () => {
    expect(calculateClickPercentage(250, 1000)).toBe(25.0);
    expect(calculateClickPercentage(180, 1000)).toBe(18.0);
    expect(calculateClickPercentage(1, 3)).toBe(33.3);
    expect(calculateClickPercentage(0, 500)).toBe(0);
    expect(calculateClickPercentage(100, 0)).toBe(0);
    expect(calculateClickPercentage(100, -5)).toBe(0);
  });

  it('sanitizeCsvFilename creates safe filenames and prevents traversal', () => {
    const filename = sanitizeCsvFilename('12345678-abcd', 'Join Now!');
    expect(filename).toBe('broadcast-12345678-join-now-users.csv');

    const unsafe = sanitizeCsvFilename('12345678-abcd', '../../../etc/passwd');
    expect(unsafe).toBe('broadcast-12345678-etc-passwd-users.csv');
  });

  it('escapeCsvCell correctly applies RFC 4180 rules', () => {
    expect(escapeCsvCell('Hello')).toBe('Hello');
    expect(escapeCsvCell('Hello, World')).toBe('"Hello, World"');
    expect(escapeCsvCell('He said "Hi"')).toBe('"He said ""Hi"""');
    expect(escapeCsvCell('Line1\nLine2')).toBe('"Line1\nLine2"');
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell(42)).toBe('42');
  });

  it('isButtonMessage and extractButtonDetails identify buttons', () => {
    const templateBtn: WhatsAppButtonMessageLike = {
      id: 'wamid-1',
      type: 'button',
      timestamp: '1700000000',
      button: { text: 'Join Now', payload: 'PAYLOAD_1' },
    };
    expect(isButtonMessage(templateBtn)).toBe(true);
    expect(extractButtonDetails(templateBtn)).toEqual({
      label: 'Join Now',
      payload: 'PAYLOAD_1',
    });

    const interactiveBtn: WhatsAppButtonMessageLike = {
      id: 'wamid-2',
      type: 'interactive',
      timestamp: '1700000000',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'btn_yes', title: 'Yes, please' },
      },
    };
    expect(isButtonMessage(interactiveBtn)).toBe(true);
    expect(extractButtonDetails(interactiveBtn)).toEqual({
      label: 'Yes, please',
      payload: 'btn_yes',
    });

    const textMsg: WhatsAppButtonMessageLike = {
      id: 'wamid-3',
      type: 'text',
      timestamp: '1700000000',
    };
    expect(isButtonMessage(textMsg)).toBe(false);
  });
});

describe('recordBroadcastButtonClickIfAny attribution logic', () => {
  it('skips tracking when message is not a button message', async () => {
    const db = { from: vi.fn() } as unknown as any;
    await recordBroadcastButtonClickIfAny(db, 'acc-1', 'cnt-1', {
      id: 'msg-1',
      type: 'text',
      timestamp: '1700000000',
    });
    expect(db.from).not.toHaveBeenCalled();
  });

  it('skips tracking when message.context.id is missing (no fallback)', async () => {
    const db = { from: vi.fn() } as unknown as any;
    await recordBroadcastButtonClickIfAny(db, 'acc-1', 'cnt-1', {
      id: 'msg-1',
      type: 'button',
      button: { text: 'Join Now' },
      timestamp: '1700000000',
      // No context.id
    });
    expect(db.from).not.toHaveBeenCalled();
  });

  it('skips tracking when context.id does not match any broadcast recipient', async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as any;

    await recordBroadcastButtonClickIfAny(db, 'acc-1', 'cnt-1', {
      id: 'msg-1',
      type: 'button',
      button: { text: 'Join Now' },
      timestamp: '1700000000',
      context: { id: 'wamid-unmatched' },
    });

    // Only broadcast_recipients was queried, no insert into broadcast_button_clicks
    expect(db.from).toHaveBeenCalledWith('broadcast_recipients');
    expect(db.from).not.toHaveBeenCalledWith('broadcast_button_clicks');
  });

  it('records button click idempotently when context.id exactly matches broadcast recipient', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null });

    const db = {
      from: vi.fn((table: string) => {
        if (table === 'broadcast_recipients') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: 'rec-1',
                    broadcast_id: 'bc-1',
                    broadcasts: {
                      id: 'bc-1',
                      account_id: 'acc-1',
                      template_name: 'test_template',
                      template_language: 'en_US',
                    },
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'message_templates') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [
                    {
                      id: 'tmpl-1',
                      name: 'test_template',
                      language: 'en_US',
                      buttons: [
                        { type: 'QUICK_REPLY', text: 'Join Now' },
                        { type: 'QUICK_REPLY', text: 'Learn More' },
                      ],
                    },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === 'broadcast_button_clicks') {
          return {
            upsert: upsertSpy,
          };
        }
        return {};
      }),
    } as unknown as any;

    await recordBroadcastButtonClickIfAny(db, 'acc-1', 'cnt-1', {
      id: 'wamid-click-123',
      type: 'button',
      button: { text: 'Join Now', payload: 'PAYLOAD_JOIN' },
      timestamp: '1700000000',
      context: { id: 'wamid-exact-match' },
    });

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'acc-1',
        broadcast_id: 'bc-1',
        contact_id: 'cnt-1',
        button_index: 0,
        button_name: 'Join Now',
        button_type: 'QUICK_REPLY',
        button_payload: 'PAYLOAD_JOIN',
        inbound_message_id: 'wamid-click-123',
      }),
      { onConflict: 'inbound_message_id', ignoreDuplicates: true }
    );
  });
});
