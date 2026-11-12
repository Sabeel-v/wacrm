import { DurableObject } from "cloudflare:workers";

/**
 * Realtime hub — replaces Supabase Realtime `postgres_changes`.
 *
 * One instance per account (`idFromName(accountId)`). Clients connect
 * with a WebSocket; server code calls `publish()` after every write to
 * messages / conversations / reactions / notifications.
 *
 * Uses the WebSocket Hibernation API so idle agent connections don't
 * keep the object in memory.
 *
 * Phase 0 skeleton: accepts sockets and fans events out. Topic
 * filtering, per-user notifications and presence come in phase 5.
 */
export class RealtimeHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send an event to every connected socket. Returns the number reached. */
  async publish(event: unknown): Promise<number> {
    const payload = JSON.stringify(event);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Socket already closing; the close handler cleans it up.
      }
    }
    return sockets.length;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Phase 0: simple ping/pong so the connection can be tested by hand.
    if (message === "ping") ws.send("pong");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
