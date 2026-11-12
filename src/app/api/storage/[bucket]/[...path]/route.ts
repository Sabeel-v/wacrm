/**
 * R2-backed replacement for Supabase Storage buckets (avatars, flow-media,
 * chat-media).
 *   GET    public read (as in Supabase: all three buckets were public)
 *   POST   upload — signed-in member, path rule per bucket (storage-rules.ts)
 *   DELETE remove — same rule
 */
import { NextResponse } from 'next/server'
import { getEnv } from '@/lib/cf-env'
import { getSessionContext } from '@/lib/auth/session'
import { BUCKETS, baseMime, safeObjectPath } from '@/lib/db/storage-rules'

type Params = { params: Promise<{ bucket: string; path: string[] }> }

const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

async function resolve(params: Params['params']) {
  const { bucket, path } = await params
  const rule = BUCKETS[bucket]
  const key = safeObjectPath((path ?? []).map(decodeURIComponent).join('/'))
  return { bucket, rule, key }
}

export async function GET(request: Request, { params }: Params) {
  const { bucket, rule, key } = await resolve(params)
  if (!rule || !key) return json({ error: 'Not found' }, 404)
  const env = await getEnv()
  const objectKey = `${bucket}/${key}`

  // Range requests: browsers need them to seek in audio/video (Safari
  // refuses to play video without them).
  const range = parseRange(request.headers.get('range'))
  if (range === 'invalid') return new Response(null, { status: 416 })

  let obj
  try {
    obj = await env.MEDIA.get(objectKey, range ? { range } : undefined)
  } catch (err) {
    // R2 throws when the range starts past the end of the object.
    if (range && /range/i.test((err as Error).message)) return new Response(null, { status: 416 })
    throw err
  }
  if (!obj) return json({ error: 'Not found' }, 404)

  const headers = new Headers()
  obj.writeHttpMetadata(headers as unknown as Parameters<typeof obj.writeHttpMetadata>[0])
  headers.set('ETag', obj.httpEtag)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', headers.get('Cache-Control') || 'public, max-age=31536000, immutable')
  headers.set('X-Content-Type-Options', 'nosniff')
  // Never let uploaded HTML/SVG run as a page on our origin.
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")

  // Revalidation: unchanged object → 304, no body.
  if (!range && request.headers.get('if-none-match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers })
  }

  if (range) {
    const r = obj.range as { offset?: number; length?: number } | undefined
    const offset = r?.offset ?? 0
    const length = r?.length ?? obj.size - offset
    if (offset >= obj.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${obj.size}` } })
    }
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
    headers.set('Content-Length', String(length))
    return new Response(obj.body as unknown as BodyInit, { status: 206, headers })
  }
  headers.set('Content-Length', String(obj.size))
  return new Response(obj.body as unknown as BodyInit, { headers })
}

/** Parse a single-range `Range: bytes=…` header into R2's range option. */
function parseRange(header: string | null): { offset?: number; length?: number; suffix?: number } | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null // multi-range or other units: serve the whole object
  const [, start, end] = m
  if (start === '' && end === '') return 'invalid'
  if (start === '') return Number(end) > 0 ? { suffix: Number(end) } : 'invalid'
  const offset = Number(start)
  if (end === '') return { offset }
  if (Number(end) < offset) return 'invalid'
  return { offset, length: Number(end) - offset + 1 }
}

async function writer(request: Request) {
  const session = await getSessionContext(request.headers)
  if (!session?.accountId) return null
  return { userId: session.userId, accountId: session.accountId }
}

export async function POST(request: Request, { params }: Params) {
  const { bucket, rule, key } = await resolve(params)
  if (!rule) return json({ error: 'Bucket not found', statusCode: '404' }, 404)
  if (!key) return json({ error: 'Invalid object path' }, 400)
  const who = await writer(request)
  if (!who) return json({ error: 'Unauthorized' }, 401)
  if (!rule.canWrite(key, who)) {
    return json({ error: 'new row violates row-level security policy', statusCode: '403' }, 403)
  }

  const type = baseMime(request.headers.get('content-type') ?? '')
  if (!rule.mime.includes(type)) return json({ error: `mime type ${type || '(none)'} is not supported` }, 415)
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > rule.maxBytes) return json({ error: 'The object exceeded the maximum allowed size' }, 413)
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > rule.maxBytes) return json({ error: 'The object exceeded the maximum allowed size' }, 413)

  const env = await getEnv()
  const objectKey = `${bucket}/${key}`
  const upsert = request.headers.get('x-upsert') === 'true'
  if (!upsert && (await env.MEDIA.head(objectKey))) return json({ error: 'The resource already exists' }, 409)
  await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType: type } })
  return json({ path: key }, 200)
}

export async function DELETE(request: Request, { params }: Params) {
  const { bucket, rule, key } = await resolve(params)
  if (!rule || !key) return json({ error: 'Not found' }, 404)
  const who = await writer(request)
  if (!who) return json({ error: 'Unauthorized' }, 401)
  if (!rule.canWrite(key, who)) return json({ error: 'Forbidden' }, 403)
  const env = await getEnv()
  await env.MEDIA.delete(`${bucket}/${key}`)
  return json({ name: key }, 200)
}
