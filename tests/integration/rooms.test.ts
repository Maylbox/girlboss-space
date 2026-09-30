import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import type { Miniflare } from "miniflare";
import { runtime } from "./runtime";
import type { PublicState, Session } from "../../src/game/protocol";
import { newShoe, type Card, type Rank } from "../../src/game/blackjack";

let mf: Miniflare;
const origin = "https://girlboss.test";
before(async () => {
  mf = await runtime(0, true);
});
after(async () => {
  await mf?.dispose();
});
async function post(path: string, body: unknown, customOrigin = origin) {
  return mf.dispatchFetch(origin + path, {
    method: "POST",
    headers: { Origin: customOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function create(nickname = "Sanne"): Promise<Session> {
  const r = await post("/api/rooms", { nickname });
  assert.equal(r.status, 201);
  return (await r.json()) as Session;
}
async function join(s: Session, nickname = "Friend"): Promise<Session> {
  const r = await post(`/api/rooms/${s.code}/join`, {
    nickname,
    invite: s.invite,
  });
  assert.equal(r.status, 200);
  return (await r.json()) as Session;
}
async function roomStub(code: string) {
  const ns = await mf.getDurableObjectNamespace("ROOMS");
  return ns.get(ns.idFromName(code));
}
async function inspect(code: string): Promise<any> {
  return await (
    await (await roomStub(code)).fetch("https://room/__test/inspect")
  ).json();
}
async function edit(code: string, change: unknown): Promise<void> {
  await (
    await roomStub(code)
  ).fetch("https://room/__test/edit", {
    method: "POST",
    body: JSON.stringify(change),
  });
  await mf.unsafeEvictDurableObject("girlboss-test", "TestRoom", {
    name: code,
    webSockets: "hibernate",
  });
}
async function alarm(code: string): Promise<void> {
  await (await roomStub(code)).fetch("https://room/__test/alarm");
}

class Client {
  state!: PublicState;
  messages: any[] = [];
  waiters: (() => void)[] = [];
  constructor(public ws: any) {
    ws.addEventListener("message", (e: any) => {
      if (e.data === "pong") return;
      const m = JSON.parse(e.data);
      this.messages.push(m);
      if (m.type === "state") this.state = m.state;
      for (const f of this.waiters.splice(0)) f();
    });
    ws.accept();
  }
  async wait(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("Timed out waiting for room update.");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  async command(type: string, extra: Record<string, unknown> = {}) {
    const id = crypto.randomUUID();
    this.ws.send(
      JSON.stringify({ id, type, version: this.state.version, ...extra }),
    );
    await this.wait(() =>
      this.messages.some((m) => m.ack === id || m.id === id),
    );
    return {
      id,
      result: this.messages.find((m) => m.ack === id || m.id === id),
    };
  }
}
async function connect(s: Session): Promise<Client> {
  const url = `${origin}/api/rooms/${s.code}/socket?playerId=${s.playerId}&credential=${s.credential}`;
  const r = await mf.dispatchFetch(url, {
    headers: { Upgrade: "websocket", Origin: origin },
  });
  assert.equal(r.status, 101);
  const client = new Client(r.webSocket!);
  await client.wait(() => !!client.state);
  return client;
}
function rig(ranks: Rank[]): Card[] {
  return [
    ...newShoe().slice(0, 150),
    ...ranks.map((rank) => ({ rank, suit: "spades" as const })).reverse(),
  ];
}

test("root is minimal; home is unlisted/noindex; all assets and clean routes work", async () => {
  const root = await mf.dispatchFetch(origin + "/");
  const rootHtml = await root.text();
  assert.equal(root.status, 200);
  assert.ok(!/Sanne|\/home|\/blackjack/.test(rootHtml));
  const home = await mf.dispatchFetch(origin + "/home/");
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, /Sanne/);
  assert.match(homeHtml, /noindex,nofollow/);
  assert.equal(home.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.ok(!/canvas|Space.Grotesk|portrait-rail/.test(homeHtml));
  const robots = await (await mf.dispatchFetch(origin + "/robots.txt")).text();
  assert.match(robots, /Disallow: \/home\//);
  for (const path of [
    "/blackjack/",
    "/blackjack/room/ABC234?invite=abc",
    "/assets/blackjack.js",
    "/assets/blackjack.css",
    "/img/icons/mc.png",
  ])
    assert.equal((await mf.dispatchFetch(origin + path)).status, 200, path);
  assert.equal(
    (await mf.dispatchFetch(origin + "/does-not-exist")).status,
    404,
  );
  assert.match(
    root.headers.get("Content-Security-Policy")!,
    /frame-ancestors 'none'/,
  );
});
test("joins require full invites; cross-site, malformed names and credentials are rejected", async () => {
  assert.equal(
    (await post("/api/rooms", { nickname: "Nope" }, "https://other.test"))
      .status,
    403,
  );
  for (const nickname of ["<script>alert(1)</script>", "", "x".repeat(25)])
    assert.equal((await post("/api/rooms", { nickname })).status, 400);
  const s = await create();
  assert.equal(
    (await post(`/api/rooms/${s.code}/join`, { nickname: "Friend" })).status,
    403,
  );
  assert.equal(
    (
      await post(`/api/rooms/${s.code}/join`, {
        nickname: "Friend",
        invite: "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post(`/api/rooms/${s.code}/join`, {
        playerId: s.playerId,
        credential: "wrong",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await mf.dispatchFetch(
        `${origin}/api/rooms/${s.code}/socket?playerId=${s.playerId}&credential=wrong`,
        { headers: { Origin: origin, Upgrade: "websocket" } },
      )
    ).status,
    401,
  );
});
test("two clients see bets, hidden hole card, turns, results; intents are deduplicated", async () => {
  const a = await create(),
    b = await join(a);
  await edit(a.code, { shoe: rig(["8", "9", "10", "7", "7", "7"]) });
  const ca = await connect(a),
    cb = await connect(b);
  await ca.wait(
    () =>
      ca.state.players.length === 2 &&
      ca.state.players.every((p) => p.connected),
  );
  const wager = await ca.command("bet", { amount: 100 });
  assert.equal(wager.result.type, "state");
  // Replaying a request must never debit the stack twice.
  ca.ws.send(
    JSON.stringify({
      id: wager.id,
      type: "bet",
      amount: 100,
      version: ca.state.version,
    }),
  );
  await cb.wait(() => cb.state.players[0].bet === 100);
  assert.equal(cb.state.players[0].balance, 900);
  await cb.command("bet", { amount: 100 });
  await ca.wait(() => ca.state.canStart);
  await ca.command("start");
  await cb.wait(() => cb.state.phase === "playing");
  assert.equal(ca.state.dealer[1], null);
  assert.equal(cb.state.dealer[1], null);
  assert.equal(ca.state.turn?.playerId, a.playerId);
  assert.ok(!JSON.stringify(ca.state).includes("shoe"));
  assert.ok(!JSON.stringify(ca.state).includes("credential"));
  const invalid = await cb.command("hit");
  assert.equal(invalid.result.type, "error");
  await ca.command("stand");
  await cb.wait(() => cb.state.turn?.playerId === b.playerId);
  await cb.command("stand");
  await ca.wait(() => ca.state.phase === "results");
  assert.equal(ca.state.dealer.length, 2);
  assert.ok(ca.state.dealer.every(Boolean));
  assert.equal(ca.state.players[0].balance, 900);
  assert.equal(ca.state.players[1].balance, 900);
  await ca.command("next");
  await cb.wait(() => cb.state.phase === "betting");
  assert.equal(cb.state.players[0].hands.length, 0);
  ca.ws.close(1000);
  cb.ws.close(1000);
});
test("refresh restores a seat; hibernation retains sockets and state; explicit leave migrates host", async () => {
  const a = await create(),
    b = await join(a);
  const ca = await connect(a),
    cb = await connect(b);
  await ca.wait(() => ca.state.players.every((p) => p.connected));
  await ca.command("bet", { amount: 50 });
  await cb.wait(() => cb.state.players[0].bet === 50);
  await mf.unsafeEvictDurableObject("girlboss-test", "TestRoom", {
    name: a.code,
    webSockets: "hibernate",
  });
  const bid = await cb.command("bet", { amount: 20 });
  assert.equal(bid.result.type, "state");
  await ca.wait(() => ca.state.players[1].bet === 20);
  ca.ws.close(1000);
  await cb.wait(() => !cb.state.players[0].connected);
  const resumed = await post(`/api/rooms/${a.code}/join`, a);
  assert.equal(resumed.status, 200);
  const ca2 = await connect((await resumed.json()) as Session);
  assert.equal(ca2.state.players[0].bet, 50);
  assert.equal(ca2.state.players.length, 2);
  await ca2.command("leave");
  await cb.wait(() => cb.state.hostId === b.playerId);
  assert.equal(cb.state.players.find((p) => p.id === b.playerId)?.active, true);
  cb.ws.close(1000);
});
test("disconnect grace cleanup migrates host, rejects stale credential, and timeout stands", async () => {
  const a = await create(),
    b = await join(a);
  await edit(a.code, { shoe: rig(["8", "9", "10", "7", "7", "7"]) });
  const ca = await connect(a),
    cb = await connect(b);
  await ca.wait(() => ca.state.players.every((p) => p.connected));
  await ca.command("bet", { amount: 10 });
  await cb.wait(() => cb.state.players[0].bet === 10);
  await cb.command("bet", { amount: 10 });
  await ca.wait(() => ca.state.canStart);
  await ca.command("start");
  ca.ws.close(1000);
  await cb.wait(() => !cb.state.players[0].connected);
  await edit(a.code, { disconnect: a.playerId });
  await alarm(a.code);
  await cb.wait(() => cb.state.hostId === b.playerId);
  assert.equal((await post(`/api/rooms/${a.code}/join`, a)).status, 401);
  assert.equal(cb.state.turn?.playerId, b.playerId);
  await edit(a.code, { timeout: true });
  await alarm(a.code);
  await cb.wait(() => cb.state.phase === "results");
  cb.ws.close(1000);
});
test("room inactivity expires storage and prevents reconnecting", async () => {
  const s = await create();
  await edit(s.code, { expire: true });
  await alarm(s.code);
  assert.equal(await inspect(s.code), null);
  assert.equal(
    (
      await post(`/api/rooms/${s.code}/join`, {
        nickname: "Friend",
        invite: s.invite,
      })
    ).status,
    404,
  );
});
