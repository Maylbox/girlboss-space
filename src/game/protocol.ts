import type { Card, Game, Player, Action } from "./blackjack";
export interface PublicState {
  code: string;
  hostId: string;
  you: string;
  version: number;
  phase: Game["phase"];
  round: number;
  dealer: (Card | null)[];
  players: Player[];
  turn: Game["turn"];
  turnDeadline: number | null;
  lastAction: string;
  actions: Action[];
  canStart: boolean;
}
export interface Session {
  code: string;
  playerId: string;
  credential: string;
  invite: string;
}
export interface Command {
  id: string;
  type: "bet" | "start" | "next" | "reset" | "leave" | Action;
  version: number;
  amount?: number;
}
export type ServerMessage =
  | { type: "state"; state: PublicState; ack?: string }
  | { type: "error"; error: string; id?: string };
