import { total, RULES, type Card } from "../game/blackjack";
import type {
  PublicState,
  ServerMessage,
  Session,
  Command,
} from "../game/protocol";

const app = document.querySelector<HTMLElement>("#app")!;
const rules = document.querySelector<HTMLDialogElement>("#rules")!;
document
  .querySelector("#show-rules")!
  .addEventListener("click", () => rules.showModal());
document
  .querySelector("#close-rules")!
  .addEventListener("click", () => rules.close());
rules.addEventListener("click", (e) => {
  if (e.target === rules) {
    const r = rules.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      rules.close();
  }
});

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Current tab still works with restricted storage. */
  }
}
function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Restricted storage. */
  }
}
function sessionKey(code: string): string {
  return `gb.table.${code}`;
}
function readSession(code: string): Session | null {
  try {
    const s = JSON.parse(
      storageGet(sessionKey(code)) ?? "null",
    ) as Session | null;
    return s?.code === code && s.playerId && s.credential ? s : null;
  } catch {
    return null;
  }
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: string } & T;
  if (!res.ok) throw new Error(data.error ?? "Unable to connect. Try again.");
  return data;
}
function inviteUrl(s: Session): string {
  return `${location.origin}/blackjack/room/${s.code}?invite=${s.invite}`;
}
function goToTable(s: Session): void {
  storageSet(sessionKey(s.code), JSON.stringify(s));
  location.assign(inviteUrl(s));
}
function parseInvite(value: string): { code: string; invite: string } {
  const input = value.trim();
  if (/^[A-HJ-NP-Z2-9]{6}$/i.test(input)) {
    const s = readSession(input.toUpperCase());
    if (!s)
      throw new Error(
        "Ask for the complete invite link. The code alone cannot grant access.",
      );
    return { code: s.code, invite: s.invite };
  }
  let url: URL;
  try {
    url = new URL(input, location.origin);
  } catch {
    throw new Error("Paste a private table invite link.");
  }
  const code = url.pathname
    .match(/^\/blackjack\/room\/([A-HJ-NP-Z2-9]{6})\/?$/i)?.[1]
    ?.toUpperCase();
  const invite = url.searchParams.get("invite");
  if (!code || !invite || !/^[a-f0-9]{64}$/.test(invite))
    throw new Error("Paste the complete private invite link.");
  return { code, invite };
}

function lobby(roomCode?: string): void {
  app.replaceChildren();
  const box = element("section", "lobby");
  const heading = element("div", "lobby-heading");
  heading.append(
    element("h1", "", roomCode ? `Table ${roomCode}` : "Blackjack"),
  );
  const body = element("div", "lobby-body");
  const form = element("form");
  const nameLabel = element("label", "", "Nickname");
  nameLabel.htmlFor = "nickname";
  const name = element("input");
  name.id = "nickname";
  name.name = "nickname";
  name.maxLength = 24;
  name.required = true;
  name.setAttribute("autocomplete", "nickname");
  name.value = storageGet("gb.nickname") ?? "";
  const error = element("p", "error");
  error.setAttribute("role", "status");
  const create = element(
    "button",
    "create",
    roomCode ? "Join table" : "Create table",
  );
  create.type = "submit";
  form.append(nameLabel, name, create);
  let joinInput: HTMLInputElement | undefined;
  let join: HTMLButtonElement | undefined;
  if (!roomCode) {
    const area = element("div", "separator");
    const label = element("label", "", "Invite link or saved table code");
    label.htmlFor = "invite";
    const row = element("div", "join-row");
    joinInput = element("input");
    joinInput.id = "invite";
    joinInput.placeholder = "Paste invite link";
    joinInput.autocomplete = "off";
    join = element("button", "", "Join");
    join.type = "button";
    row.append(joinInput, join);
    area.append(label, row);
    form.append(area);
  }
  body.append(form, error);
  box.append(heading, body);
  app.append(box);
  async function submit(joinExisting: boolean): Promise<void> {
    if (!form.reportValidity()) return;
    error.textContent = "";
    create.disabled = true;
    if (join) join.disabled = true;
    storageSet("gb.nickname", name.value.trim());
    try {
      if (roomCode || joinExisting) {
        const invite = roomCode
          ? (new URL(location.href).searchParams.get("invite") ??
            readSession(roomCode)?.invite)
          : parseInvite(joinInput!.value).invite;
        const code = roomCode ?? parseInvite(joinInput!.value).code;
        if (!invite)
          throw new Error("Ask for the complete private invite link.");
        const saved = readSession(code);
        if (saved) {
          try {
            goToTable(await post<Session>(`/api/rooms/${code}/join`, saved));
            return;
          } catch {
            storageRemove(sessionKey(code));
          }
        }
        goToTable(
          await post<Session>(`/api/rooms/${code}/join`, {
            nickname: name.value,
            invite,
          }),
        );
      } else
        goToTable(await post<Session>("/api/rooms", { nickname: name.value }));
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : "Unable to connect.";
      create.disabled = false;
      if (join) join.disabled = false;
    }
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit(false);
  });
  join?.addEventListener("click", () => {
    void submit(true);
  });
  joinInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit(true);
    }
  });
}

const symbols = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
function cardView(card: Card | null): HTMLElement {
  const cardEl = element(
    "div",
    `playing-card${card === null ? " back" : ["hearts", "diamonds"].includes(card.suit) ? " red" : ""}`,
  );
  cardEl.setAttribute("role", "img");
  if (!card) {
    cardEl.setAttribute("aria-label", "Dealer hole card, face down");
    cardEl.append(element("span", "card-monogram", "gb"));
    return cardEl;
  }
  cardEl.setAttribute("aria-label", `${card.rank} of ${card.suit}`);
  for (const pos of ["", " bottom"]) {
    const corner = element("span", `card-corner${pos}`);
    corner.setAttribute("aria-hidden", "true");
    corner.append(
      element("span", "", card.rank),
      element("span", "suit", symbols[card.suit]),
    );
    cardEl.append(corner);
  }
  const face = ["J", "Q", "K"].includes(card.rank);
  if (face) cardEl.classList.add("face");
  const center = element(
    "span",
    "card-center",
    face ? card.rank : symbols[card.suit],
  );
  center.setAttribute("aria-hidden", "true");
  cardEl.append(center);
  return cardEl;
}
const renderedCards = new Map<string, string[]>();
function cardsView(cards: (Card | null)[], key: string): HTMLElement {
  const row = element("div", "hand-cards");
  const previous = renderedCards.get(key) ?? [];
  const identities = cards.map((card) =>
    card ? `${card.rank}:${card.suit}` : "hidden",
  );
  cards.forEach((card, index) => {
    const view = cardView(card);
    if (previous[index] !== identities[index]) view.classList.add("dealt");
    row.append(view);
  });
  renderedCards.set(key, identities);
  return row;
}

let session: Session | null = null;
let state: PublicState | null = null;
let socket: WebSocket | null = null;
let pending: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let retries = 0;
let terminal = false;
let leaving = false;
let connection = "connecting…";
let message = "";
let selectedBet = "50";
let roomParts: {
  table: HTMLElement;
  status: HTMLElement;
  statusMessage: HTMLElement;
  people: HTMLElement;
  error: HTMLElement;
  connection: HTMLElement;
  copy: HTMLButtonElement;
  fallback: HTMLElement;
} | null = null;

function mountRoom(): void {
  app.replaceChildren();
  const header = element("div", "room-header");
  const title = element("div", "room-title");
  title.append(
    element("h1", "", "Blackjack"),
    element("code", "", session!.code),
  );
  const tools = element("div", "room-tools");
  const connected = element("span", "connection", connection);
  connected.setAttribute("role", "status");
  const copy = element("button", "", "Copy invite link");
  copy.type = "button";
  const leave = element("button", "text-button", "Leave");
  leave.type = "button";
  const fallback = element("div", "invite-fallback");
  fallback.hidden = true;
  tools.append(connected, copy, leave);
  header.append(title, tools);
  const table = element("section", "table");
  table.setAttribute("aria-label", "Blackjack table");
  const status = element("div", "table-status");
  const statusMessage = element("p");
  statusMessage.setAttribute("role", "status");
  statusMessage.setAttribute("aria-live", "polite");
  status.append(statusMessage);
  const people = element("p", "people");
  const error = element("p", "error room-error");
  error.setAttribute("role", "status");
  app.append(header, fallback, table, status, people, error);
  roomParts = {
    table,
    status,
    statusMessage,
    people,
    error,
    connection: connected,
    copy,
    fallback,
  };
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(session!));
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy invite link";
      }, 1800);
    } catch {
      const input = element("input");
      input.value = inviteUrl(session!);
      input.readOnly = true;
      input.setAttribute("aria-label", "Private invite link, select and copy");
      fallback.hidden = false;
      fallback.replaceChildren(input);
      input.select();
    }
  });
  leave.addEventListener("click", () => {
    if (terminal || !state) {
      storageRemove(sessionKey(session!.code));
      location.assign("/blackjack/");
      return;
    }
    leaving = true;
    send("leave");
  });
}
function renderRoom(): void {
  if (!roomParts) mountRoom();
  const parts = roomParts!;
  parts.connection.textContent = connection;
  parts.connection.classList.toggle("offline", connection !== "connected");
  parts.error.textContent = message;
  if (!state) {
    parts.table.replaceChildren(
      element("p", "loading", "Waiting for the table…"),
    );
    return;
  }
  const s = state;
  // Preserve the focused control through broadcasts when possible.
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.focus
      : undefined;
  const dealer = element("div", "dealer");
  dealer.append(
    element("h2", "", "Dealer"),
    cardsView(s.dealer, `${s.round}:dealer`),
  );
  if (s.dealer.length)
    dealer.append(
      element(
        "p",
        "card-total",
        s.dealer.includes(null)
          ? "Hole card hidden"
          : `${total(s.dealer as Card[]).value}`,
      ),
    );
  const rule = element(
    "p",
    "table-rule",
    "BLACKJACK PAYS 3 TO 2 · DEALER STANDS ON 17",
  );
  const seats = element("div", "seats");
  for (const p of s.players) {
    const you = p.id === s.you;
    const seat = element(
      "article",
      `seat${you ? " you" : ""}${s.turn?.playerId === p.id ? " turn" : ""}`,
    );
    seat.append(
      element(
        "h3",
        "",
        `${p.name}${you ? " (you)" : ""}${p.id === s.hostId ? " · host" : ""}`,
      ),
    );
    const wager = p.hands.length
      ? p.hands.reduce((sum, h) => sum + h.bet, 0)
      : p.bet;
    seat.append(
      element(
        "p",
        "seat-meta",
        `${p.balance.toLocaleString()} chips${wager ? ` · bet ${wager}` : ""}${!p.active ? " · left" : !p.connected ? " · disconnected" : ""}`,
      ),
    );
    const hands = element("div", "player-hands");
    for (let i = 0; i < p.hands.length; i++) {
      const h = p.hands[i];
      const hand = element(
        "div",
        `player-hand${s.turn?.playerId === p.id && s.turn.hand === i ? " current" : ""}`,
      );
      const handTotal = total(h.cards);
      hand.append(
        cardsView(h.cards, `${s.round}:${p.id}:${i}`),
        element(
          "p",
          "card-total",
          `${handTotal.value}${handTotal.soft ? " · soft" : ""}${p.hands.length > 1 ? ` · bet ${h.bet}` : ""}`,
        ),
      );
      const result = h.outcome
        ? `${h.outcome === "lose" ? "Lost" : h.outcome === "win" ? "Won" : h.outcome === "push" ? "Push" : "Blackjack"}${h.net ? ` ${h.net > 0 ? "+" : ""}${h.net}` : ""}`
        : h.status === "playing"
          ? ""
          : h.status === "blackjack"
            ? "Blackjack"
            : h.status === "bust"
              ? "Bust"
              : "Stand";
      hand.append(element("p", "hand-outcome", result));
      hands.append(hand);
    }
    if (!p.hands.length)
      hands.append(
        element(
          "p",
          "waiting-label",
          s.phase === "playing"
            ? "Joining next round"
            : p.bet
              ? "Bet locked"
              : p.balance < RULES.minBet
                ? "Sitting out"
                : "Choosing a bet",
        ),
      );
    seat.append(hands);
    if (you && p.active) {
      const controls = element("div", "controls");
      if (s.phase === "betting" && p.balance + p.bet >= RULES.minBet) {
        const form = element("form", "bet-form");
        const label = element("label", "", "Bet");
        label.htmlFor = "bet";
        const input = element("input");
        input.id = "bet";
        input.type = "number";
        input.min = "10";
        input.max = String(Math.min(250, p.balance + p.bet));
        input.step = "10";
        input.required = true;
        input.value = selectedBet;
        input.dataset.focus = "bet";
        input.setAttribute("aria-label", "Bet in chips");
        input.addEventListener("input", () => {
          selectedBet = input.value;
        });
        const submit = element("button", "", p.bet ? "Change bet" : "Lock bet");
        submit.type = "submit";
        submit.disabled = !!pending || connection !== "connected";
        submit.dataset.focus = "lock";
        input.disabled = submit.disabled;
        form.append(label, input, submit);
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          if (form.reportValidity()) send("bet", Number(input.value));
        });
        controls.append(form);
      }
      if (s.phase !== "playing" && p.balance < RULES.minBet && p.bet === 0)
        controls.append(actionButton("Reset chips", "reset"));
      for (const action of s.actions)
        controls.append(
          actionButton(action[0].toUpperCase() + action.slice(1), action),
        );
      seat.append(controls);
    }
    seats.append(seat);
  }
  parts.table.replaceChildren(dealer, rule, seats);
  const turnPlayer = s.players.find((p) => p.id === s.turn?.playerId);
  parts.statusMessage.textContent =
    s.phase === "playing"
      ? `${turnPlayer?.id === s.you ? "Your turn" : `${turnPlayer?.name}'s turn`}. ${s.lastAction}`
      : s.phase === "results"
        ? `Round ${s.round} finished. ${s.lastAction}`
        : s.lastAction;
  parts.status.querySelector("button")?.remove();
  if (s.hostId === s.you && s.phase === "betting") {
    const b = actionButton("Deal cards", "start");
    b.classList.add("host-action");
    b.disabled ||= !s.canStart;
    parts.status.append(b);
  }
  if (s.hostId === s.you && s.phase === "results") {
    const b = actionButton("Next round", "next");
    b.classList.add("host-action");
    parts.status.append(b);
  }
  parts.people.textContent = s.players
    .filter((p) => p.active)
    .map((p) => `${p.name}${p.connected ? "" : " (away)"}`)
    .join(" · ");
  if (focused)
    app
      .querySelector<HTMLElement>(`[data-focus="${focused}"]`)
      ?.focus({ preventScroll: true });
}
function actionButton(label: string, type: Command["type"]): HTMLButtonElement {
  const b = element("button", "", label);
  b.type = "button";
  b.disabled = !!pending || connection !== "connected";
  b.dataset.focus = type;
  b.addEventListener("click", () => send(type));
  return b;
}
function send(type: Command["type"], amount?: number): void {
  if (pending || !state || socket?.readyState !== WebSocket.OPEN) {
    leaving = false;
    return;
  }
  const id = crypto.randomUUID();
  pending = id;
  message = "";
  socket.send(
    JSON.stringify({
      id,
      type,
      amount,
      version: state.version,
    } satisfies Command),
  );
  pendingTimer = setTimeout(() => {
    pending = null;
    leaving = false;
    message = "Connection interrupted; resyncing the table…";
    socket?.close();
  }, 8000);
  renderRoom();
}
function clearPending(): void {
  pending = null;
  clearTimeout(pendingTimer);
}
function connect(): void {
  if (!session || terminal) return;
  connection = retries ? "reconnecting…" : "connecting…";
  renderRoom();
  const url = new URL(`/api/rooms/${session.code}/socket`, location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("playerId", session.playerId);
  url.searchParams.set("credential", session.credential);
  const current = new WebSocket(url);
  socket = current;
  current.addEventListener("open", () => {
    if (socket !== current) return;
    connection = "connected";
    retries = 0;
    message = "";
    renderRoom();
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (current.readyState === WebSocket.OPEN) current.send("ping");
    }, 25000);
  });
  current.addEventListener("message", (event) => {
    if (socket !== current || event.data === "pong") return;
    try {
      const data = JSON.parse(event.data) as ServerMessage;
      if (data.type === "state") {
        state = data.state;
        if (data.ack && data.ack === pending) {
          clearPending();
          if (leaving) {
            terminal = true;
            storageRemove(sessionKey(session!.code));
            location.assign("/blackjack/");
            return;
          }
        }
      } else if (data.type === "error") {
        if (data.id === pending) clearPending();
        leaving = false;
        message = data.error;
      }
      renderRoom();
    } catch {
      message = "Unable to read the table update.";
      renderRoom();
    }
  });
  current.addEventListener("close", (event) => {
    if (socket !== current) return;
    clearInterval(heartbeat);
    clearPending();
    leaving = false;
    if (event.code === 4001 || event.code === 4004 || retries >= 7) {
      terminal = true;
      connection = "disconnected";
      message =
        event.code === 4001
          ? "This seat was opened in another tab. You can leave this tab."
          : "Table unavailable. Reopen your invite link to join again.";
      if (event.code !== 4001) storageRemove(sessionKey(session!.code));
      renderRoom();
      return;
    }
    retries++;
    connection = "reconnecting…";
    renderRoom();
    retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** retries));
  });
  current.addEventListener("error", () => {
    message = "Connection lost; trying again…";
    renderRoom();
  });
}
window.addEventListener("pagehide", () => {
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  socket?.close(1000, "Page closed.");
});
const roomCode = location.pathname.match(
  /^\/blackjack\/room\/([A-HJ-NP-Z2-9]{6})\/?$/,
)?.[1];
if (roomCode) {
  session = readSession(roomCode);
  if (session) {
    try {
      session = await post<Session>(`/api/rooms/${roomCode}/join`, session);
      storageSet(sessionKey(roomCode), JSON.stringify(session));
      mountRoom();
      connect();
    } catch (e) {
      storageRemove(sessionKey(roomCode));
      session = null;
      lobby(roomCode);
      const error = app.querySelector(".error");
      if (error)
        error.textContent =
          e instanceof Error ? e.message : "Join again with your invite.";
    }
  } else lobby(roomCode);
} else lobby();
