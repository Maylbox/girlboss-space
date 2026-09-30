export type Rank =
  "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
export type Suit = "hearts" | "diamonds" | "clubs" | "spades";
export interface Card {
  rank: Rank;
  suit: Suit;
}
export interface Hand {
  cards: Card[];
  bet: number;
  split: boolean;
  status: "playing" | "stood" | "bust" | "blackjack";
  outcome?: "win" | "lose" | "push" | "blackjack";
  net?: number;
}
export interface Player {
  id: string;
  name: string;
  balance: number;
  bet: number;
  hands: Hand[];
  active: boolean;
  connected: boolean;
  joinedAt: number;
  disconnectedAt?: number;
}
export interface Game {
  phase: "betting" | "playing" | "results";
  round: number;
  players: Player[];
  dealer: Card[];
  shoe: Card[];
  turn: { playerId: string; hand: number } | null;
  lastAction: string;
}
export const RULES = {
  decks: 6,
  startingChips: 1000,
  minBet: 10,
  maxBet: 250,
  betStep: 10,
  maxHands: 3,
  cutCard: 0.25,
};
export const RANKS: Rank[] = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];
export const SUITS: Suit[] = ["hearts", "diamonds", "clubs", "spades"];

export function total(cards: Card[]): { value: number; soft: boolean } {
  let value = 0,
    aces = 0;
  for (const c of cards) {
    if (c.rank === "A") {
      aces++;
      value += 11;
    } else value += ["J", "Q", "K"].includes(c.rank) ? 10 : Number(c.rank);
  }
  while (value > 21 && aces > 0) {
    value -= 10;
    aces--;
  }
  return { value, soft: aces > 0 };
}
export function natural(cards: Card[], split = false): boolean {
  return !split && cards.length === 2 && total(cards).value === 21;
}
export function dealerShouldHit(cards: Card[]): boolean {
  return total(cards).value < 17;
}

// Rejection sampling avoids modulo bias, including for a six-deck shoe.
export function randomBelow(bound: number): number {
  const limit = Math.floor(0x100000000 / bound) * bound;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % bound;
}
export function newShoe(): Card[] {
  const shoe: Card[] = [];
  for (let d = 0; d < RULES.decks; d++)
    for (const suit of SUITS)
      for (const rank of RANKS) shoe.push({ rank, suit });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}
export function needsShuffle(shoe: Card[]): boolean {
  return shoe.length <= RULES.decks * 52 * RULES.cutCard;
}
export function draw(game: Game): Card {
  // A pathological round can exhaust even a fresh shoe. Never deal undefined.
  if (!game.shoe.length) game.shoe = newShoe();
  return game.shoe.pop()!;
}
export function createGame(): Game {
  return {
    phase: "betting",
    round: 0,
    players: [],
    dealer: [],
    shoe: newShoe(),
    turn: null,
    lastAction: "Choose your bets.",
  };
}
export function playerById(game: Game, id: string): Player {
  const p = game.players.find((p) => p.id === id && p.active);
  if (!p) throw new Error("Your seat is no longer active.");
  return p;
}
export function bet(game: Game, id: string, amount: number): void {
  if (game.phase !== "betting") throw new Error("Betting is closed.");
  const p = playerById(game, id);
  if (
    !Number.isSafeInteger(amount) ||
    amount < RULES.minBet ||
    amount > RULES.maxBet ||
    amount % RULES.betStep !== 0
  )
    throw new Error("Bet 10–250 chips, in steps of 10.");
  if (p.balance + p.bet < amount) throw new Error("Not enough chips.");
  p.balance += p.bet - amount;
  p.bet = amount;
  game.lastAction = `${p.name} bet ${amount}.`;
}
export function canStart(game: Game): boolean {
  const seated = game.players.filter(
    (p) => p.active && p.connected && p.balance + p.bet >= RULES.minBet,
  );
  return (
    game.phase === "betting" &&
    seated.length > 0 &&
    seated.every((p) => p.bet > 0)
  );
}
function makeHand(cards: Card[], wager: number, split = false): Hand {
  const value = total(cards).value;
  return {
    cards,
    bet: wager,
    split,
    status: natural(cards, split)
      ? "blackjack"
      : value > 21
        ? "bust"
        : value === 21
          ? "stood"
          : "playing",
  };
}
export function start(game: Game): void {
  if (!canStart(game))
    throw new Error("Wait for all connected players to bet.");
  if (needsShuffle(game.shoe)) game.shoe = newShoe();
  game.round++;
  game.phase = "playing";
  game.dealer = [];
  for (const p of game.players) {
    p.hands = [];
    if (p.active && p.connected && p.bet) p.hands = [makeHand([], p.bet)];
    else if (p.bet) {
      p.balance += p.bet;
      p.bet = 0;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const p of game.players)
      if (p.hands.length) p.hands[0].cards.push(draw(game));
    game.dealer.push(draw(game));
  }
  for (const p of game.players)
    if (p.hands.length) p.hands[0] = makeHand(p.hands[0].cards, p.bet);
  game.lastAction = `Round ${game.round}.`;
  if (natural(game.dealer)) settle(game);
  else advance(game);
}
export type Action = "hit" | "stand" | "double" | "split";
export function legalActions(game: Game, id: string): Action[] {
  if (game.phase !== "playing" || game.turn?.playerId !== id) return [];
  const p = game.players.find((p) => p.id === id);
  const hand = p?.hands[game.turn.hand];
  if (!p?.active || !hand || hand.status !== "playing") return [];
  const actions: Action[] = ["hit", "stand"];
  if (hand.cards.length === 2 && p.balance >= hand.bet) {
    actions.push("double");
    if (
      p.hands.length < RULES.maxHands &&
      hand.cards[0].rank === hand.cards[1].rank
    )
      actions.push("split");
  }
  return actions;
}
export function act(game: Game, id: string, action: Action): void {
  if (!legalActions(game, id).includes(action))
    throw new Error("That action is not available on your turn.");
  const p = playerById(game, id),
    i = game.turn!.hand,
    h = p.hands[i];
  if (action === "stand") h.status = "stood";
  if (action === "hit" || action === "double") {
    if (action === "double") {
      p.balance -= h.bet;
      h.bet *= 2;
    }
    h.cards.push(draw(game));
    const value = total(h.cards).value;
    h.status =
      value > 21
        ? "bust"
        : action === "double" || value === 21
          ? "stood"
          : "playing";
  }
  if (action === "split") {
    p.balance -= h.bet;
    const ace = h.cards[0].rank === "A";
    const a = makeHand([h.cards[0], draw(game)], h.bet, true);
    const b = makeHand([h.cards[1], draw(game)], h.bet, true);
    if (ace) {
      a.status = "stood";
      b.status = "stood";
    }
    p.hands.splice(i, 1, a, b);
  }
  game.lastAction = `${p.name} ${action === "hit" ? "hit" : action === "stand" ? "stood" : action === "split" ? "split" : `doubled to ${h.bet}`}.`;
  advance(game);
}
function advance(game: Game): void {
  for (const p of game.players)
    for (let i = 0; i < p.hands.length; i++) {
      if (p.hands[i].status === "playing") {
        game.turn = { playerId: p.id, hand: i };
        return;
      }
    }
  const needsDealer = game.players.some((p) =>
    p.hands.some((h) => h.status === "stood"),
  );
  if (needsDealer)
    while (dealerShouldHit(game.dealer)) game.dealer.push(draw(game));
  settle(game);
}
export function payout(
  hand: Hand,
  dealer: Card[],
): { outcome: NonNullable<Hand["outcome"]>; returned: number; net: number } {
  const value = total(hand.cards).value,
    dv = total(dealer).value;
  let outcome: NonNullable<Hand["outcome"]>,
    returned = 0;
  if (value > 21) outcome = "lose";
  else if (natural(dealer)) {
    outcome = natural(hand.cards, hand.split) ? "push" : "lose";
    returned = outcome === "push" ? hand.bet : 0;
  } else if (natural(hand.cards, hand.split)) {
    outcome = "blackjack";
    returned = hand.bet * 2.5;
  } else if (dv > 21 || value > dv) {
    outcome = "win";
    returned = hand.bet * 2;
  } else if (value === dv) {
    outcome = "push";
    returned = hand.bet;
  } else outcome = "lose";
  return { outcome, returned, net: returned - hand.bet };
}
function settle(game: Game): void {
  for (const p of game.players)
    for (const h of p.hands) {
      const result = payout(h, game.dealer);
      p.balance += result.returned;
      h.outcome = result.outcome;
      h.net = result.net;
    }
  game.phase = "results";
  game.turn = null;
  game.lastAction = natural(game.dealer)
    ? "Dealer Blackjack."
    : "Round finished.";
}
export function nextRound(game: Game): void {
  if (game.phase !== "results") throw new Error("Finish this round first.");
  game.players = game.players.filter((p) => p.active);
  for (const p of game.players) {
    p.bet = 0;
    p.hands = [];
  }
  game.dealer = [];
  game.turn = null;
  game.phase = "betting";
  game.lastAction = "Choose your bets.";
}
export function deactivate(game: Game, id: string): void {
  const p = game.players.find((p) => p.id === id);
  if (!p) return;
  p.active = false;
  p.connected = false;
  if (game.phase === "betting") {
    p.balance += p.bet;
    p.bet = 0;
  }
  for (const h of p.hands) if (h.status === "playing") h.status = "stood";
  if (game.phase === "playing") advance(game);
}
export function resetChips(game: Game, id: string): void {
  const p = playerById(game, id);
  if (game.phase === "playing" || p.balance >= RULES.minBet || p.bet !== 0)
    throw new Error("Reset a stack below the minimum bet between rounds.");
  p.balance = RULES.startingChips;
  game.lastAction = `${p.name} reset to ${RULES.startingChips} fictional chips.`;
}
