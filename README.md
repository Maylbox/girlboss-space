# girlboss.space

A personal website and private multiplayer Blackjack simulator, deployed together as a Cloudflare Worker. The game uses fictional session chips only: no purchases, cash-out, prizes, accounts, or permanent economy.

| Route                                   | Page                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| `/`                                     | Minimal holding page                                             |
| `/home/`                                | Unlisted personal homepage, with the original content and images |
| `/blackjack/`                           | Create or join a table                                           |
| `/blackjack/room/<code>?invite=<token>` | Private room invite                                              |

`/home/` is unlisted and has both a robots meta tag and an `X-Robots-Tag` header. It is excluded in `robots.txt`. **It is not password protected**; anyone who knows the address can open it. Neither the root nor the Blackjack interface links to it.

## Local setup

Install Node.js **22 or newer** and npm. Clone the repository, then run:

```sh
npm ci
npm run dev
```

Open the localhost address printed by Wrangler (usually `http://localhost:8787/blackjack/`). Wrangler runs the Worker, assets, SQLite storage, Durable Objects and WebSockets locally. After editing client code or static files, rerun `npm run build`; Wrangler reloads the Worker automatically. No permanent local server is needed after deployment.

Create a table, copy its invite link and open that link in a **different browser, private window, or browser profile** to try a second player. A refresh reconnects your existing seat. Two tabs in one browser profile share a seat; opening the second replaces the first connection.

## Deploy to Cloudflare

1. Sign into the Cloudflare account that owns your domain:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

2. Review `wrangler.jsonc`. It binds `ROOMS` to `BlackjackRoom` and declares the class in `exports` with SQLite storage. **Wrangler provisions the namespace on the first deploy.** You do not need to manually create a Durable Object, create a database, or run a migration command. This new project uses Cloudflare's declarative class configuration rather than legacy tagged migrations. Keep the class name and storage backend unchanged after deploying so existing rooms retain their namespace.

3. Deploy:

   ```sh
   npm run deploy
   ```

   Open the printed `workers.dev` URL at `/blackjack/`. Test a complete round with a second browser before switching the domain.

4. In Cloudflare, open **Workers & Pages → girlboss-space → Settings → Domains & Routes → Add → Custom Domain**, and enter `girlboss.space`. The domain must be in the same Cloudflare account. If the hostname is currently attached to a Pages project or another Worker, remove that conflicting assignment first. Cloudflare manages the DNS record and TLS certificate for the Worker Custom Domain.

   Alternatively, add this top-level configuration before deploying:

   ```jsonc
   "routes": [{ "pattern": "girlboss.space", "custom_domain": true }]
   ```

Deploy this as a **Worker with static assets**, not a static-only Pages upload. Uploading only `dist/` cannot run the multiplayer server. To connect GitHub through Cloudflare Workers Builds, select this repository, use `npm run build` as the build command and `npx wrangler deploy` as the deploy command. The Durable Object binding and class configuration remain in the checked-in Wrangler configuration.

For CI deployment, use Cloudflare's `CLOUDFLARE_API_TOKEN` and, if necessary, `CLOUDFLARE_ACCOUNT_ID` environment variables. Store them in your deployment service's secrets, never in this repository.

## Code layout

```text
public/
  index.html                minimal root
  home/                     personal homepage and original photo manifest
  blackjack/                lobby / room document
  assets/                   local stylesheets
  img/                      original image assets
src/
  client/index.ts           browser forms, cards and WebSocket client
  worker/index.ts           routing, asset responses, origin checks
  durable-objects/room.ts    one authoritative room per Durable Object
  game/blackjack.ts          pure game rules and secure shuffle
  game/protocol.ts           browser / room message types
scripts/build.mjs           copies assets and bundles the client
tests/                      rule and real Workers-runtime integration tests
wrangler.jsonc              Worker, static assets and Durable Object configuration
```

The build writes `dist/`; generated output and local state are ignored by Git. All fonts and game visuals are local/system assets. The old continuous portrait and comet animations, external Google font and modern glass/card layout have been removed.

## Table behavior

- Up to six players. A single player can practice before friends join.
- Private invites carry a random 256-bit token. A short code works in the lobby only if that browser already remembers the corresponding invite.
- Host starts once every connected player with sufficient chips has locked a bet. Players who join during a hand sit out until the next round.
- Turns stand automatically after 60 seconds. Disconnects retain a seat for 90 seconds; after that, outstanding hands stand and the oldest remaining connected player inherits the host role. Explicitly leaving transfers host immediately.
- Room state, shoe, requests and reconnect credentials survive hibernation/restarts. Dealer hole cards and the shoe never appear in client state.
- Tabs automatically reconnect and resync. Buttons wait for the server acknowledgement; request IDs prevent double processing. Stale-state commands are rejected rather than replayed.
- A stack below the minimum bet can be reset to 1,000 fictional chips between rounds. This also handles the five-chip remainder possible after a 3:2 payout.
- Rooms and reconnect credentials expire after 24 hours without room activity. Automatic WebSocket heartbeats do not extend this period.
- Nicknames are validated, output uses DOM text nodes, request sizes are bounded and actions are throttled. Creation throttling is best-effort per Worker isolate; use a Cloudflare rate-limiting rule for `/api/rooms` if you make the game widely available.

The rules dialog lists the complete fixed ruleset: six decks, stand on soft 17, 3:2 naturals, dealer peek, double after split, matching-rank splits up to three hands, one card to split aces, no insurance or surrender. At 25% remaining, the shoe reshuffles before a new round. If an exceptionally long round exhausts the shoe, drawing continues from a new securely shuffled shoe.

## Editing

- **Chips, bets, deck count and cut threshold:** `RULES` in `src/game/blackjack.ts`. Update the rules dialog in `public/blackjack/index.html` when changing the rules.
- **Room expiry, reconnect grace and turn timeout:** constants in `src/durable-objects/room.ts`.
- **Unlisted homepage route and security headers:** `src/worker/index.ts`, plus `public/robots.txt` and `public/home/index.html`.
- **Personal content:** `public/home/index.html`. Existing biographical statements are preserved from the original website; update them there as needed.
- **Visuals:** `public/assets/site.css` and `public/assets/blackjack.css`.

There is no chat, sound, public room index, account system or external backend dependency in this version.

## Validation

```sh
npm run check
npm test
npm run build
npm run test:integration
npx wrangler deploy --dry-run
```

The integration suite runs isolated Miniflare instances with real Workers/Durable Object storage and sockets. Test-only inspection helpers are bundled **only by the test fixture**, never by Wrangler or the production build. Tests cover private invites, origin checks, two-client play, hidden cards, deduplication, reconnection, hibernation, host transfer, timed-out turns and room expiry.

For browser checks:

```sh
npx playwright install chromium
npm run test:browser
```

Browser tests launch a local Miniflare server and separate browser profiles. You can set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium binary. These checks cover lobby forms, copied invites, a complete multiplayer round, refresh, host transfer, mobile overflow and the unlisted homepage.

Cloudflare references: [Worker static assets](https://developers.cloudflare.com/workers/static-assets/), [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/), [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
