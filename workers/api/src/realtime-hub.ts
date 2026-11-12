import { DurableObject } from "cloudflare:workers";

/**
 * Realtime hub: replaces Supabase Realtime (`postgres_changes`) and the
 * `member_presence` table. One instance per account (`idFromName(accountId)`).
 *
 *   - Browsers connect with a WebSocket (authenticated by a ticket checked in
 *     the API worker, which passes the verified user id in `x-user-id`).
 *   - The data layer calls `publish(event)` after every write to messages,
 *     conversations, message_reactions and notifications.
 *   - Members heartbeat through the `touch_presence` RPC, which calls
 *     `touch()`. State is kept in Durable Object storage and replayed to new
 *     sockets as `member_presence` events.
 *
 * Uses the WebSocket Hibernation API, so idle connections don't keep the
 * object in memory (and don't bill duration).
 */
interface Attachment {
  userId: string;
}

interface PresenceRow {
  status: "online" | "away";
  last_seen_at: string;
}

export class RealtimeHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const userId = request.headers.get("x-user-id") ?? "";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId } satisfies Attachment);

    // Replay current presence so the roster is correct immediately.
    const rows = await this.ctx.storage.list<PresenceRow>({ prefix: "presence:" });
    for (const [key, row] of rows) {
      server.send(
        JSON.stringify({
          type: "change",
          table: "member_presence",
          eventType: "UPDATE",
          new: { user_id: key.slice("presence:".length), ...row },
          old: {},
        }),
      );
    }
    server.send(JSON.stringify({ type: "ready" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send a change to the account's sockets (or one user's, if `userId` is set). Returns sockets reached. */
  async publish(event: { userId?: string } & Record<string, unknown>): Promise<number> {
    const { userId, ...rest } = event;
    return this.broadcast(JSON.stringify(rest), userId);
  }

  /** Record a member heartbeat and tell everyone. */
  async touch(userId: string, status: "online" | "away"): Promise<void> {
    const row: PresenceRow = { status, last_seen_at: new Date().toISOString() };
    await this.ctx.storage.put(`presence:${userId}`, row);
    this.broadcast(
      JSON.stringify({
        type: "change",
        table: "member_presence",
        eventType: "UPDATE",
        new: { user_id: userId, ...row },
        old: {},
      }),
    );
  }

  private broadcast(payload: string, onlyUserId?: string): number {
    let reached = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (onlyUserId) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.userId !== onlyUserId) continue;
      }
      try {
        ws.send(payload);
        reached++;
      } catch {
        // Socket is closing; the close handler cleans up.
      }
    }
    return reached;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Keep-alive: the client pings; hibernation wakes us just for this.
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }
}
