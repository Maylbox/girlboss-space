import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  bet,
  canStart,
  createGame,
  deactivate,
  dealerShouldHit,
  draw,
  legalActions,
  natural,
  needsShuffle,
  newShoe,
  nextRound,
  payout,
  resetChips,
  start,
  total,
  type Card,
  type Game,
  type Hand,
  type Rank,
} from "../src/game/blackjack";

const c = (rank: Rank): Card => ({ rank, suit: "spades" });
function game(names = ["one"]): Game {
  const g = createGame();
  g.players = names.map((name, i) => ({
    id: name,
    name,
    balance: 1000,
    bet: 0,
    hands: [],
    active: true,
    connected: true,
    joinedAt: i,
  }));
  return g;
}
function rig(g: Game, ranks: Rank[]): void {
  g.shoe = [...newShoe().slice(0, 150), ...ranks.map(c).reverse()];
}
function hand(ranks: Rank[], wager = 100, split = false): Hand {
  return { cards: ranks.map(c), bet: wager, split, status: "stood" };
}

test("aces use the highest non-busting total, tracking soft hands", () => {
  assert.deepEqual(total(["A", "A", "9"].map(c)), { value: 21, soft: true });
  assert.deepEqual(total(["A", "6", "10"].map(c)), { value: 17, soft: false });
  assert.deepEqual(total(["A", "A", "K", "9"].map(c)), {
    value: 21,
    soft: false,
  });
  assert.deepEqual(total([]), { value: 0, soft: false });
});
test("natural Blackjack excludes split and three-card 21", () => {
  assert.equal(natural(["A", "K"].map(c)), true);
  assert.equal(natural(["A", "K"].map(c), true), false);
  assert.equal(natural(["7", "7", "7"].map(c)), false);
});
test("dealer stands on soft 17, hits soft 16", () => {
  assert.equal(dealerShouldHit(["A", "6"].map(c)), false);
  assert.equal(dealerShouldHit(["A", "5"].map(c)), true);
  assert.equal(dealerShouldHit(["10", "7"].map(c)), false);
});
test("payouts: natural, split 21, dealer natural, bust, win, loss, push", () => {
  assert.deepEqual(payout(hand(["A", "K"]), ["10", "9"].map(c)), {
    outcome: "blackjack",
    returned: 250,
    net: 150,
  });
  assert.deepEqual(payout(hand(["A", "K"], 100, true), ["10", "9"].map(c)), {
    outcome: "win",
    returned: 200,
    net: 100,
  });
  assert.equal(payout(hand(["A", "K"]), ["A", "K"].map(c)).returned, 100);
  assert.equal(
    payout(hand(["A", "K"], 100, true), ["A", "K"].map(c)).returned,
    0,
  );
  assert.equal(
    payout(hand(["K", "Q", "2"]), ["K", "Q", "2"].map(c)).returned,
    0,
  );
  assert.equal(payout(hand(["K", "9"]), ["K", "8"].map(c)).returned, 200);
  assert.equal(payout(hand(["K", "8"]), ["K", "9"].map(c)).returned, 0);
  assert.equal(payout(hand(["K", "9"]), ["K", "9"].map(c)).returned, 100);
  assert.equal(payout(hand(["K", "8"]), ["K", "Q", "2"].map(c)).returned, 200);
});
test("bet edits reserve chips once and reject malicious amounts", () => {
  const g = game();
  bet(g, "one", 100);
  bet(g, "one", 50);
  assert.equal(g.players[0].balance, 950);
  for (const amount of [-10, 0, 15, 251, NaN, Infinity, 50.5])
    assert.throws(() => bet(g, "one", amount));
  assert.equal(g.players[0].balance, 950);
});
test("all solvent connected players must bet; disconnected reservations are refunded", () => {
  const g = game(["one", "two"]);
  bet(g, "one", 100);
  assert.equal(canStart(g), false);
  bet(g, "two", 50);
  g.players[1].connected = false;
  rig(g, ["8", "10", "7", "7"]);
  start(g);
  assert.equal(g.players[1].balance, 1000);
  assert.equal(g.players[1].bet, 0);
});
test("wrong-player, wrong-phase and unaffordable actions are rejected without mutation", () => {
  const g = game(["one", "two"]);
  assert.throws(() => act(g, "one", "hit"));
  bet(g, "one", 100);
  bet(g, "two", 100);
  rig(g, ["8", "9", "10", "7", "7", "7"]);
  start(g);
  const before = JSON.stringify(g);
  assert.throws(() => act(g, "two", "hit"));
  assert.throws(() => bet(g, "one", 100));
  assert.equal(JSON.stringify(g), before);
  g.players[0].balance = 0;
  assert.deepEqual(legalActions(g, "one"), ["hit", "stand"]);
  assert.throws(() => act(g, "one", "double"));
});
test("hitting into bust advances to the next seat", () => {
  const g = game(["one", "two"]);
  bet(g, "one", 100);
  bet(g, "two", 100);
  rig(g, ["10", "8", "10", "9", "7", "7", "5"]);
  start(g);
  act(g, "one", "hit");
  assert.equal(g.players[0].hands[0].status, "bust");
  assert.equal(g.turn?.playerId, "two");
});
test("double reserves another bet and deals exactly one card, then stands", () => {
  const g = game();
  bet(g, "one", 100);
  rig(g, ["5", "10", "6", "7", "10"]);
  start(g);
  act(g, "one", "double");
  assert.equal(g.players[0].hands[0].bet, 200);
  assert.equal(g.players[0].hands[0].cards.length, 3);
  assert.equal(g.players[0].balance, 1200);
  assert.equal(g.phase, "results");
});
test("dealer peek resolves naturals before player actions", () => {
  const g = game(["one", "two"]);
  bet(g, "one", 100);
  bet(g, "two", 100);
  rig(g, ["A", "10", "A", "K", "8", "K"]);
  start(g);
  assert.equal(g.phase, "results");
  assert.equal(g.players[0].balance, 1000);
  assert.equal(g.players[1].balance, 900);
  assert.deepEqual(legalActions(g, "one"), []);
});
test("player natural returns the stake plus 3:2", () => {
  const g = game();
  bet(g, "one", 10);
  rig(g, ["A", "10", "K", "7"]);
  start(g);
  assert.equal(g.players[0].balance, 1015);
  assert.equal(g.phase, "results");
});
test("split matching ranks, up to three hands, with double after split", () => {
  const g = game();
  bet(g, "one", 100);
  rig(g, ["8", "10", "8", "7", "8", "3", "2", "3", "10"]);
  start(g);
  act(g, "one", "split");
  assert.equal(g.players[0].hands.length, 2);
  assert.equal(g.players[0].balance, 800);
  assert.ok(legalActions(g, "one").includes("double"));
  act(g, "one", "split");
  assert.equal(g.players[0].hands.length, 3);
  assert.equal(g.players[0].balance, 700);
  assert.ok(!legalActions(g, "one").includes("split"));
  act(g, "one", "double");
  assert.equal(g.players[0].hands[0].bet, 200);
});
test("different ten-value ranks cannot split", () => {
  const g = game();
  bet(g, "one", 100);
  rig(g, ["K", "10", "Q", "7"]);
  start(g);
  assert.ok(!legalActions(g, "one").includes("split"));
});
test("split aces each receive one card, stand, and never pay as naturals", () => {
  const g = game();
  bet(g, "one", 100);
  rig(g, ["A", "10", "A", "7", "K", "9"]);
  start(g);
  act(g, "one", "split");
  assert.equal(g.phase, "results");
  assert.equal(g.players[0].hands.length, 2);
  assert.ok(
    g.players[0].hands.every(
      (h) =>
        h.cards.length === 2 && h.status === "stood" && h.outcome === "win",
    ),
  );
  assert.equal(g.players[0].balance, 1200);
});
test("leaving on a turn stands hands and the room can complete the round", () => {
  const g = game(["one", "two"]);
  bet(g, "one", 100);
  bet(g, "two", 100);
  rig(g, ["8", "9", "10", "7", "7", "7"]);
  start(g);
  deactivate(g, "one");
  assert.equal(g.turn?.playerId, "two");
  act(g, "two", "stand");
  assert.equal(g.phase, "results");
  nextRound(g);
  assert.equal(g.players.length, 1);
  assert.equal(g.phase, "betting");
});
test("six-deck shuffle preserves 312 cards and reshuffles only at cut threshold", () => {
  const shoe = newShoe();
  assert.equal(shoe.length, 312);
  for (const rank of ["A", "10", "K"])
    assert.equal(shoe.filter((c) => c.rank === rank).length, 24);
  assert.equal(needsShuffle(shoe.slice(0, 79)), false);
  assert.equal(needsShuffle(shoe.slice(0, 78)), true);
  const g = game();
  g.shoe = [];
  assert.ok(draw(g));
  assert.equal(g.shoe.length, 311);
  g.shoe = newShoe().slice(0, 2);
  bet(g, "one", 100);
  start(g);
  assert.ok(g.shoe.length >= 290);
});
test("empty fictional stack resets between rounds only", () => {
  const g = game();
  assert.throws(() => resetChips(g, "one"));
  g.players[0].balance = 0;
  resetChips(g, "one");
  assert.equal(g.players[0].balance, 1000);
  g.players[0].balance = 5;
  resetChips(g, "one");
  assert.equal(g.players[0].balance, 1000);
  g.phase = "playing";
  g.players[0].balance = 0;
  assert.throws(() => resetChips(g, "one"));
});
