/**
 * Server-side `supabase.storage` replacement backed by R2 (binding MEDIA).
 * Trusted server code only (e.g. mirroring inbound WhatsApp media); bucket
 * MIME/size limits are still enforced, path rules are not (service role).
 */
import { getEnv } from '@/lib/cf-env'
import type { StorageApi } from './client-core'
import { BUCKETS, baseMime, publicUrl, safeObjectPath } from './storage-rules'

const fail = (message: string, code = 'storage_error') => ({
  data: null,
  error: { message, code, details: null, hint: null },
})

export function serverStorage(): StorageApi {
  return {
    from(bucket) {
      return {
        async upload(path, body, options) {
          const rule = BUCKETS[bucket]
          const key = safeObjectPath(path)
          if (!rule) return fail(`Bucket not found: ${bucket}`, 'not_found')
          if (!key) return fail('Invalid object path', 'invalid_path')
          const type = baseMime(options?.contentType ?? (body instanceof Blob ? body.type : '') ?? '')
          if (type && !rule.mime.includes(type)) return fail(`mime type ${type} is not supported`, 'invalid_mime_type')
          const bytes = body instanceof Blob ? await body.arrayBuffer() : body
          const size = bytes instanceof ArrayBuffer ? bytes.byteLength : (bytes as Uint8Array).byteLength
          if (size > rule.maxBytes) return fail('The object exceeded the maximum allowed size', 'payload_too_large')

          const env = await getEnv()
          const objectKey = `${bucket}/${key}`
          if (!options?.upsert && (await env.MEDIA.head(objectKey))) {
            return fail('The resource already exists', 'Duplicate')
          }
          await env.MEDIA.put(objectKey, bytes as ArrayBuffer, {
            httpMetadata: { contentType: type || 'application/octet-stream', cacheControl: options?.cacheControl ? `max-age=${options.cacheControl}` : undefined },
          })
          return { data: { path: key }, error: null }
        },
        async remove(paths) {
          const env = await getEnv()
          const keys = paths.map(safeObjectPath).filter((p): p is string => !!p)
          if (keys.length) await env.MEDIA.delete(keys.map((k) => `${bucket}/${k}`))
          return { data: keys.map((name) => ({ name })), error: null }
        },
        getPublicUrl(path) {
          return { data: { publicUrl: publicUrl(bucket, path) } }
        },
      }
    },
  }
}
