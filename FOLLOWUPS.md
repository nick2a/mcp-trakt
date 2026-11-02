# Follow-ups

Open work on this fork, roughly in priority order. Each item says what we
saw and why it matters; delete an item in the commit that resolves it.

## 1. Lookup for "is X on my list?"

A membership question currently pulls the whole list in compact mode
(~83k characters for a 653-item watchlist). Add a lookup that takes
`imdb`/`trakt` ids (and maybe a title match) and returns only the
matching rows. Consider one shared lookup across watchlist, watched and
ratings rather than a filter on each tool, since the question is usually
"have I seen it, rated it, or listed it?".

## 2. Normal-mode pages exceed Claude Code's inline limit

Claude Code saves text results over 50,000 characters to a file. A
default `get_watchlist` page (100 items, `extended=full`) is ~305k
characters, so it always falls back to a file. Options: a smaller
default `limit` on tools that request `extended=full`, or making
`extended` opt-in. Compact mode is unaffected (it declares a 150k limit).

## 3. Date range on `get_history`

History is one row per play and grows forever (619 rows at the time of
writing), so it was deliberately left out of compact mode. Questions
about it are usually time-bounded ("what did I watch last month?");
Trakt supports `start_at`/`end_at` on `/sync/history`.

## 4. Watchlist is over the free-tier cap

The watchlist holds 653 items; Trakt's 2026 free-tier limit is 250. The
import was not blocked, but `add_to_watchlist` may be. Try one add and
see how Trakt responds before relying on it.

## 5. Custom lists and favourites tools

There are no tools for `/users/me/lists` (create, read or edit your own
lists) or for favourites.

## 6. Keep tokens out of process arguments

`keychainWrite` (in `setup.js` and `src/index.ts`) passes tokens to
`security add-generic-password -w <token>`, so they are briefly visible
to other processes via `ps`. Feed the command to `security -i` on stdin
instead.

## 7. Vitest runs the compiled tests in `dist/`

After `npm run build`, `npm test` also picks up `dist/__tests__/`, so
every test runs twice. Exclude `dist/` in a vitest config.

## 8. Duplicate tools when Claude runs inside this repo

The repo's `.mcp.json` registers `mcp-trakt` (source via `tsx`), and the
user-scope `trakt` server runs the built `dist/`. Started inside this
folder with both enabled, Claude sees every tool twice, and the two
copies drift apart whenever `src/` changes without a rebuild. Disable
one with `/mcp`, or start Claude from outside the repo.
