'use client'
/**
 * Browser realtime client: a supabase-js-compatible `channel()` backed by one
 * shared WebSocket to the account's RealtimeHub Durable Object.
 *
 *   channel(name).on('postgres_changes', {event, table, filter?}, cb).subscribe(cb)
 *
 * Filters support `column=eq.value`, like Supabase. The socket is opened when
 * the first channel subscribes and closed when the last one leaves. It
 * reconnects with backoff, getting a fresh ticket each time.
 */
import type { RealtimeChannel } from './client-core'

interface Handler {
  event: string
  table: string
  filter?: { column: string; value: string }
  callback: (payload: unknown) => void
}

interface Subscriber {
  handlers: Handler[]
  onStatus?: (status: string, err?: Error) => void
}

const subscribers = new Set<Subscriber>()
let socket: WebSocket | null = null
let connecting = false
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let ready = false

const PING_MS = 25_000

function parseFilter(filter: unknown): Handler['filter'] {
  if (typeof filter !== 'string') return undefined
  const m = /^([a-z_]+)=eq\.(.*)$/.exec(filter)
  return m ? { column: m[1], value: m[2] } : undefined
}

function notifyStatus(status: string) {
  for (const s of subscribers) s.onStatus?.(status)
}

function dispatch(msg: {
  type?: string
  table?: string
  eventType?: string
  new?: Record<string, unknown>
  old?: Record<string, unknown>
}) {
  if (msg.type !== 'change' || !msg.table || !msg.eventType) return
  const row = msg.eventType === 'DELETE' ? msg.old ?? {} : msg.new ?? {}
  const payload = { schema: 'public', table: msg.table, eventType: msg.eventType, new: msg.new ?? {}, old: msg.old ?? {} }
  for (const s of subscribers) {
    for (const h of s.handlers) {
      if (h.table !== msg.table) continue
      if (h.event !== '*' && h.event !== msg.eventType) continue
      if (h.filter && String(row[h.filter.column]) !== h.filter.value) continue
      try {
        h.callback(payload)
      } catch (e) {
        console.error('[realtime] handler error:', e)
      }
    }
  }
}

async function connect() {
  if (connecting || socket || subscribers.size === 0 || typeof window === 'undefined') return
  connecting = true
  try {
    const res = await fetch('/api/realtime/ticket', { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) throw new Error(`ticket ${res.status}`)
    const { ticket } = (await res.json()) as { ticket: string }
    if (subscribers.size === 0) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/realtime/socket?ticket=${encodeURIComponent(ticket)}`)
    socket = ws
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'ready') {
          ready = true
          retry = 0
          notifyStatus('SUBSCRIBED')
          return
        }
        dispatch(msg)
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (socket === ws) socket = null
      ready = false
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      if (subscribers.size > 0) {
        notifyStatus('CLOSED')
        scheduleReconnect()
      }
    }
    ws.onerror = () => ws.close()
    ws.onopen = () => {
      pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS)
    }
  } catch {
    scheduleReconnect()
  } finally {
    connecting = false
  }
}

function scheduleReconnect() {
  if (retryTimer || subscribers.size === 0) return
  const delay = Math.min(30_000, 1000 * 2 ** retry++) + Math.random() * 500
  retryTimer = setTimeout(() => {
    retryTimer = null
    void connect()
  }, delay)
}

function release() {
  if (subscribers.size > 0) return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  if (pingTimer) clearInterval(pingTimer)
  pingTimer = null
  socket?.close()
  socket = null
  ready = false
  retry = 0
}

export function realtimeChannel(_name: string): RealtimeChannel {
  void _name
  const sub: Subscriber = { handlers: [] }
  const ch: RealtimeChannel = {
    on(type, filter, callback) {
      if (type === 'postgres_changes') {
        sub.handlers.push({
          event: String(filter.event ?? '*'),
          table: String(filter.table ?? ''),
          filter: parseFilter(filter.filter),
          callback,
        })
      }
      return ch
    },
    subscribe(callback) {
      sub.onStatus = callback
      subscribers.add(sub)
      if (ready) queueMicrotask(() => callback?.('SUBSCRIBED'))
      else void connect()
      return ch
    },
    async unsubscribe() {
      subscribers.delete(sub)
      release()
      return 'ok'
    },
  }
  return ch
}
