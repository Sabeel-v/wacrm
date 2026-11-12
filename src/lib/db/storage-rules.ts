/**
 * Supabase Storage buckets → one R2 bucket (binding MEDIA), keyed
 * `<bucket>/<path>`. Rules ported from migrations 008, 016, 020, 023, 039.
 * All three buckets were public-read in Supabase and stay public-read
 * (served by /api/storage/<bucket>/<path>).
 */
export interface BucketRule {
  maxBytes: number
  mime: string[]
  /** May `userId` / `accountId` write to `path`? (first folder rule) */
  canWrite(path: string, who: { userId: string; accountId: string }): boolean
}

const OFFICE = [
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]

const firstFolder = (path: string) => path.split('/')[0] ?? ''

export const BUCKETS: Record<string, BucketRule> = {
  avatars: {
    maxBytes: 2 * 1024 * 1024,
    mime: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    canWrite: (path, who) => firstFolder(path) === who.userId,
  },
  'flow-media': {
    maxBytes: 16 * 1024 * 1024,
    mime: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/3gpp', ...OFFICE],
    // 020: account folder, or the legacy per-user folder.
    canWrite: (path, who) => firstFolder(path) === `account-${who.accountId}` || firstFolder(path) === who.userId,
  },
  'chat-media': {
    maxBytes: 16 * 1024 * 1024,
    mime: [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/3gpp', 'video/3gp', 'video/quicktime',
      ...OFFICE,
      'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/opus',
    ],
    canWrite: (path, who) => firstFolder(path) === `account-${who.accountId}`,
  },
}

/** Reject traversal and odd characters; returns the normalised path or null. */
export function safeObjectPath(path: string): string | null {
  const p = path.replace(/^\/+/, '')
  if (!p || p.length > 512) return null
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  if (/[\u0000-\u001f\\]/.test(p)) return null
  return p
}

/** Base MIME type without parameters (e.g. "audio/ogg; codecs=opus" → "audio/ogg"). */
export const baseMime = (type: string) => type.split(';')[0].trim().toLowerCase()

/** Public URL for an object. Absolute when NEXT_PUBLIC_SITE_URL is set (Meta must fetch media links). */
export function publicUrl(bucket: string, path: string, origin?: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || origin || '').replace(/\/+$/, '')
  return `${base}/api/storage/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`
}
