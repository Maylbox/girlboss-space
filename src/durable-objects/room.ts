import { DurableObject } from "cloudflare:workers";
import {
  act,
  bet,
  canStart,
  createGame,
  deactivate,
  legalActions,
  nextRound,
  resetChips,
  RULES,
  start,
  type Game,
  type Player,
} from "../game/blackjack";
import type { Command, PublicState, Session } from "../game/protocol";

export const ROOM_TTL = 24 * 60 * 60 * 1000;
export const RECONNECT_GRACE = 90 * 1000;
export const TURN_TIMEOUT = 60 * 1000;
export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}
interface Member {
  credential: string;
  expiresAt: number;
  requests: string[];
}
interface SavedRoom {
  code: string;
  invite: string;
  hostId: string;
  game: Game;
  members: Record<string, Member>;
  lastActivity: number;
  version: number;
  turnDeadline: number | null;
}
interface Attachment {
  playerId: string;
  count: number;
  window: number;
}
export function token(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function nickname(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a nickname.");
  const name = value.trim().normalize("NFKC");
  if (!name || name.length > 24 || /[<>\u0000-\u001f\u007f]/u.test(name))
    throw new Error("Use a nickname of 1–24 characters, without HTML.");
  return name;
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export class BlackjackRoom extends DurableObject<Env> {
  private room: SavedRoom | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<SavedRoom>("room")) ?? null;
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  fetch(request: Request): Promise<Response> {
    return this.serialized(() => this.handleFetch(request));
  }
  private async handleFetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (this.room && Date.now() - this.room.lastActivity >= ROOM_TTL)
        await this.expire();
      if (url.pathname === "/initialize" && request.method === "POST") {
        if (this.room) return json({ error: "Code already in use." }, 409);
        const data = (await request.json()) as {
          code?: unknown;
          nickname?: unknown;
        };
        if (
          typeof data.code !== "string" ||
          !/^[A-HJ-NP-Z2-9]{6}$/.test(data.code)
        )
          return json({ error: "Invalid room code." }, 400);
        const name = nickname(data.nickname);
        this.room = {
          code: data.code,
          invite: token(),
          hostId: "",
          game: createGame(),
          members: {},
          lastActivity: Date.now(),
          version: 0,
          turnDeadline: null,
        };
        const session = this.addPlayer(name);
        this.room.hostId = session.playerId;
        await this.save();
        return json(session, 201);
      }
      if (!this.room)
        return json(
          { error: "This table has expired or does not exist." },
          404,
        );
      if (url.pathname === "/join" && request.method === "POST") {
        const data = (await request.json()) as {
          invite?: unknown;
          playerId?: string;
          credential?: string;
          nickname?: unknown;
        };
        await this.cleanup();
        if (data.playerId && data.credential) {
          const member = this.room.members[data.playerId];
          const p = this.room.game.players.find(
            (p) => p.id === data.playerId && p.active,
          );
          if (
            !member ||
            !p ||
            member.credential !== data.credential ||
            (!p.connected && member.expiresAt <= Date.now())
          )
            return json(
              {
                error:
                  "Your reconnect time has expired. Join again with the invite link.",
              },
              401,
            );
          this.room.lastActivity = Date.now();
          member.expiresAt = Date.now() + RECONNECT_GRACE;
          await this.save();
          return json(this.session(data.playerId));
        }
        if (typeof data.invite !== "string" || data.invite !== this.room.invite)
          return json(
            {
              error:
                "Paste the complete private invite link; a room code alone cannot grant access.",
            },
            403,
          );
        const name = nickname(data.nickname);
        if (this.room.game.phase !== "playing") this.removeInactive();
        if (this.room.game.players.length >= 6)
          return json(
            { error: "This table is full. Try again between rounds." },
            409,
          );
        const session = this.addPlayer(name);
        if (!this.room.hostId) this.room.hostId = session.playerId;
        this.room.lastActivity = Date.now();
        this.room.version++;
        await this.save();
        this.broadcast();
        return json(session);
      }
      if (url.pathname === "/socket") {
        if (
          request.method !== "GET" ||
          request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
        )
          return json({ error: "WebSocket required." }, 426);
        await this.cleanup();
        const playerId = url.searchParams.get("playerId") ?? "",
          secret = url.searchParams.get("credential");
        const member = this.room.members[playerId];
        const p = this.room.game.players.find(
          (p) => p.id === playerId && p.active,
        );
        if (
          !member ||
          !p ||
          secret !== member.credential ||
          (!p.connected && member.expiresAt <= Date.now())
        )
          return json(
            { error: "Invalid or expired reconnect credential." },
            401,
          );
        // A seat has one socket; refreshing replaces the old tab without creating another player.
        for (const ws of this.ctx.getWebSockets(playerId))
          ws.close(4001, "Seat opened in another tab.");
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [playerId]);
        pair[1].serializeAttachment({
          playerId,
          count: 0,
          window: Date.now(),
        } satisfies Attachment);
        p.connected = true;
        delete p.disconnectedAt;
        member.expiresAt = Date.now() + RECONNECT_GRACE;
        this.room.lastActivity = Date.now();
        this.room.version++;
        this.ensureHost();
        await this.save();
        this.broadcast();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Unable to join table.",
        },
        400,
      );
    }
  }
  private addPlayer(name: string): Session {
    const r = this.room!,
      id = crypto.randomUUID(),
      now = Date.now();
    r.game.players.push({
      id,
      name,
      balance: RULES.startingChips,
      bet: 0,
      hands: [],
      active: true,
      connected: false,
      joinedAt: now,
      disconnectedAt: now,
    });
    r.members[id] = {
      credential: token(),
      expiresAt: now + RECONNECT_GRACE,
      requests: [],
    };
    return this.session(id);
  }
  private session(id: string): Session {
    return {
      code: this.room!.code,
      playerId: id,
      credential: this.room!.members[id].credential,
      invite: this.room!.invite,
    };
  }
  webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    return this.serialized(async () => {
      let requestId: string | undefined;
      try {
        if (!this.room || Date.now() - this.room.lastActivity >= ROOM_TTL) {
          await this.expire();
          return;
        }
        const a = ws.deserializeAttachment() as Attachment;
        if (typeof message !== "string" || message.length > 1024)
          throw new Error("Invalid message.");
        if (Date.now() - a.window > 1000) {
          a.window = Date.now();
          a.count = 0;
        }
        a.count++;
        ws.serializeAttachment(a);
        if (a.count > 8) throw new Error("Slow down a little.");
        const command = JSON.parse(message) as Command;
        if (
          !command ||
          typeof command !== "object" ||
          typeof command.id !== "string" ||
          command.id.length > 64 ||
          command.id.length < 1
        )
          throw new Error("Invalid command.");
        requestId = command.id;
        const member = this.room.members[a.playerId];
        const p = this.room.game.players.find(
          (p) => p.id === a.playerId && p.active,
        );
        if (
          !member ||
          !p ||
          ws.readyState !== WebSocket.OPEN ||
          !this.ctx.getWebSockets(a.playerId).includes(ws)
        )
          throw new Error("Your seat is no longer active.");
        if (member.requests.includes(command.id)) {
          this.sendState(ws, command.id);
          return;
        }
        await this.cleanup();
        if (command.version !== this.room.version) {
          this.sendState(ws);
          throw new Error("The table changed. Try again.");
        }
        const before = this.turnKey();
        switch (command.type) {
          case "bet":
            bet(this.room.game, a.playerId, command.amount!);
            break;
          case "hit":
          case "stand":
          case "double":
          case "split":
            act(this.room.game, a.playerId, command.type);
            break;
          case "start":
            this.requireHost(a.playerId);
            start(this.room.game);
            break;
          case "next":
            this.requireHost(a.playerId);
            nextRound(this.room.game);
            this.removeInactive();
            break;
          case "reset":
            resetChips(this.room.game, a.playerId);
            break;
          case "leave":
            deactivate(this.room.game, a.playerId);
            this.room.game.lastAction = `${p.name} left.`;
            this.ensureHost();
            break;
          default:
            throw new Error("Unknown command.");
        }
        member.requests.push(command.id);
        member.requests = member.requests.slice(-32);
        member.expiresAt = Date.now() + RECONNECT_GRACE;
        this.room.version++;
        this.room.lastActivity = Date.now();
        if (this.turnKey() !== before)
          this.room.turnDeadline = this.room.game.turn
            ? Date.now() + TURN_TIMEOUT
            : null;
        await this.save();
        this.broadcast(ws, command.id);
        if (command.type === "leave") ws.close(1000, "Left table.");
      } catch (error) {
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              id: requestId,
              error:
                error instanceof Error ? error.message : "Invalid message.",
            }),
          );
        } catch {
          /* Socket already closed. */
        }
      }
    });
  }
  private requireHost(id: string): void {
    if (this.room!.hostId !== id) throw new Error("Only the host can do that.");
  }
  private turnKey(): string {
    const t = this.room?.game.turn;
    return t ? `${t.playerId}:${t.hand}` : "";
  }
  private ensureHost(): void {
    const r = this.room!;
    if (r.game.players.some((p) => p.id === r.hostId && p.active)) return;
    r.hostId =
      [...r.game.players]
        .filter((p) => p.active && p.connected)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0]?.id ?? "";
  }
  private removeInactive(): void {
    const r = this.room!;
    for (const id of Object.keys(r.members))
      if (!r.game.players.some((p) => p.id === id && p.active))
        delete r.members[id];
    r.game.players = r.game.players.filter((p) => p.active);
  }
  private async cleanup(): Promise<void> {
    const r = this.room!;
    let changed = false;
    for (const p of r.game.players)
      if (
        p.active &&
        p.disconnectedAt !== undefined &&
        Date.now() - p.disconnectedAt >= RECONNECT_GRACE
      ) {
        deactivate(r.game, p.id);
        changed = true;
      }
    this.ensureHost();
    if (
      r.game.turn &&
      r.turnDeadline !== null &&
      Date.now() >= r.turnDeadline
    ) {
      act(r.game, r.game.turn.playerId, "stand");
      r.game.lastAction = "Turn timed out; hand stood.";
      changed = true;
    }
    if (changed) {
      r.version++;
      r.turnDeadline = r.game.turn ? Date.now() + TURN_TIMEOUT : null;
      if (r.game.phase !== "playing") this.removeInactive();
      await this.save();
      this.broadcast();
    }
  }
  private view(id: string): PublicState {
    const r = this.room!;
    return {
      code: r.code,
      hostId: r.hostId,
      you: id,
      version: r.version,
      phase: r.game.phase,
      round: r.game.round,
      dealer: r.game.dealer.map((c, i) =>
        i === 1 && r.game.phase === "playing" ? null : c,
      ),
      players: r.game.players,
      turn: r.game.turn,
      turnDeadline: r.turnDeadline,
      lastAction: r.game.lastAction,
      actions: legalActions(r.game, id),
      canStart: canStart(r.game),
    };
  }
  private sendState(ws: WebSocket, ack?: string): void {
    const a = ws.deserializeAttachment() as Attachment;
    try {
      ws.send(
        JSON.stringify({ type: "state", state: this.view(a.playerId), ack }),
      );
    } catch {
      /* Close handler cleans up. */
    }
  }
  private broadcast(actor?: WebSocket, ack?: string): void {
    for (const ws of this.ctx.getWebSockets())
      this.sendState(ws, ws === actor ? ack : undefined);
  }
  private async save(): Promise<void> {
    await this.ctx.storage.put("room", this.room);
    const r = this.room!;
    const deadlines = [r.lastActivity + ROOM_TTL];
    if (r.turnDeadline !== null) deadlines.push(r.turnDeadline);
    for (const p of r.game.players)
      if (p.active && p.disconnectedAt !== undefined)
        deadlines.push(p.disconnectedAt + RECONNECT_GRACE);
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 50, Math.min(...deadlines)),
    );
  }
  private async expire(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4004, "Table expired.");
    this.room = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  alarm(): Promise<void> {
    return this.serialized(async () => {
      if (!this.room) return;
      if (Date.now() - this.room.lastActivity >= ROOM_TTL) {
        await this.expire();
        return;
      }
      await this.cleanup();
      await this.save();
    });
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    return this.disconnected(ws, code, reason);
  }
  webSocketError(ws: WebSocket): Promise<void> {
    return this.disconnected(ws, 1011, "Connection lost.");
  }
  private disconnected(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    return this.serialized(async () => {
      try {
        ws.close(code, reason);
      } catch {
        /* Already closed. */
      }
      if (!this.room) return;
      const a = ws.deserializeAttachment() as Attachment;
      if (
        this.ctx
          .getWebSockets(a.playerId)
          .some((other) => other !== ws && other.readyState === WebSocket.OPEN)
      )
        return;
      const p: Player | undefined = this.room.game.players.find(
        (p) => p.id === a.playerId && p.active,
      );
      if (!p) return;
      p.connected = false;
      p.disconnectedAt = Date.now();
      this.room.members[p.id].expiresAt = Date.now() + RECONNECT_GRACE;
      this.room.version++;
      await this.save();
      this.broadcast();
    });
  }
}
