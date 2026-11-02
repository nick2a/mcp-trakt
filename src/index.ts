#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { execFileSync } from "child_process"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { z } from "zod"

if (process.argv[2] === "setup") {
  const { spawnSync } = await import("child_process")
  const setupScript = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "setup.js",
  )
  const result = spawnSync(process.execPath, [setupScript], {
    stdio: "inherit",
  })
  process.exit(result.status ?? 0)
}

const KEYCHAIN_SERVICE = "mcp-trakt"

const keychainRead = (account: string): string | null => {
  try {
    return (
      execFileSync(
        "security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
        .toString()
        .trim() || null
    )
  } catch {
    return null
  }
}

const keychainWrite = (account: string, value: string) =>
  execFileSync("security", [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    account,
    "-w",
    value,
  ])

const CLIENT_ID = process.env.MCP_TRAKT_CLIENT_ID || keychainRead("client-id")
// Refresh is Keychain-only: an env-var token has nowhere durable to store its
// replacement, so env-var mode keeps the old no-refresh behaviour.
const tokenFromEnv = Boolean(process.env.MCP_TRAKT_ACCESS_TOKEN)
let accessToken =
  process.env.MCP_TRAKT_ACCESS_TOKEN || keychainRead("access-token")

// Tests import this module to exercise the tool handlers against a mocked
// fetch; they must not trip the credential guard, which would exit the whole
// test runner. The real CLI still fails fast when creds are genuinely missing.
const runningUnderTest = process.env.VITEST === "true"

if (!CLIENT_ID && !runningUnderTest) {
  console.error(
    "Missing client ID — set MCP_TRAKT_CLIENT_ID or run: npx @kud/mcp-trakt setup",
  )
  process.exit(1)
}

if (!accessToken && !runningUnderTest) {
  console.error(
    "Missing access token — set MCP_TRAKT_ACCESS_TOKEN or run: npx @kud/mcp-trakt setup",
  )
  process.exit(1)
}

export const API_BASE = "https://api.trakt.tv"
// Must match the redirect URI setup.js signs in with.
const REDIRECT_URI = "http://localhost:8080/callback"

let refreshing: Promise<boolean> | null = null

// Trakt refresh tokens are single-use: every refresh returns a new pair and
// invalidates the old refresh token. So concurrent callers share one refresh,
// and if the Keychain already holds a different token than the one that was
// rejected (refreshed by this process after the request was sent, or by another
// MCP client), it is adopted instead of spending a second refresh.
const refreshAccessToken = async (rejected: string | null): Promise<boolean> => {
  if (tokenFromEnv) return false
  refreshing ??= (async () => {
    const stored = keychainRead("access-token")
    if (stored && stored !== rejected) {
      accessToken = stored
      return true
    }
    const refreshToken = keychainRead("refresh-token")
    if (!refreshToken) return false
    const response = await fetch(`${API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "User-Agent": "mcp-trakt",
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": CLIENT_ID!,
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        grant_type: "refresh_token",
      }),
    })
    if (!response.ok) {
      console.error(
        `Token refresh failed: ${response.status} ${response.statusText} — run: npx @kud/mcp-trakt setup`,
      )
      return false
    }
    const token = (await response.json()) as {
      access_token: string
      refresh_token: string
    }
    // Refresh token first: the old one is already dead, so it must not be lost.
    // Access token last: another process treats a changed access token as
    // "refresh complete" and adopts it.
    keychainWrite("refresh-token", token.refresh_token)
    keychainWrite("access-token", token.access_token)
    accessToken = token.access_token
    return true
  })()
    .catch((error) => {
      console.error("Token refresh failed", error)
      return false
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

// Sends an authenticated request; on 401 refreshes the token and retries once.
const authedFetch = async (path: string, options: RequestInit = {}) => {
  const send = () =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "User-Agent": "mcp-trakt",
        "trakt-api-version": "2",
        "trakt-api-key": CLIENT_ID!,
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...options.headers,
      },
    })
  const sentWith = accessToken
  const response = await send()
  if (response.status === 401 && (await refreshAccessToken(sentWith)))
    return send()
  return response
}

export const apiFetch = async <T>(
  path: string,
  options: RequestInit = {},
): Promise<T | null> => {
  try {
    const response = await authedFetch(path, options)
    if (!response.ok) {
      console.error(
        `API error: ${response.status} ${response.statusText} — ${path}`,
      )
      return null
    }
    if (response.status === 204) return null
    return (await response.json()) as T
  } catch (error) {
    console.error(`Fetch failed: ${path}`, error)
    return null
  }
}

type Pagination = {
  page: number
  limit: number
  pageCount: number
  itemCount: number
}

// For list endpoints Trakt paginates (default 100 per page). Returns the page's
// items plus the X-Pagination-* headers, so the caller can see there is more
// instead of silently getting only page 1. pagination is null if Trakt sent none.
export const apiFetchPage = async <T>(
  path: string,
): Promise<{ items: T[]; pagination: Pagination | null } | null> => {
  try {
    const response = await authedFetch(path)
    if (!response.ok) {
      console.error(
        `API error: ${response.status} ${response.statusText} — ${path}`,
      )
      return null
    }
    const header = (name: string) =>
      response.headers.get(`x-pagination-${name}`)
    const pagination = header("page-count")
      ? {
          page: Number(header("page")),
          limit: Number(header("limit")),
          pageCount: Number(header("page-count")),
          itemCount: Number(header("item-count")),
        }
      : null
    return { items: (await response.json()) as T[], pagination }
  } catch (error) {
    console.error(`Fetch failed: ${path}`, error)
    return null
  }
}

const pageQuery = (page: number, limit: number) => `page=${page}&limit=${limit}`

// Input schema shared by the paginated list tools.
const pageInput = (defaultLimit: number) => ({
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(1)
    .describe(
      "Page to fetch, starting at 1; the result's pagination.pageCount says how many pages exist",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(defaultLimit)
    .describe("Items per page"),
})

const compactInput = {
  compact: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Fetch every page and return only type, title, year, imdb/trakt ids and dates, minified. Use to scan or count the whole list; ignores page, limit and extended",
    ),
}

// Compact mode stops after this many pages (100 items each) and reports
// truncated: true, so one call can't grow without bound.
const COMPACT_MAX_PAGES = 20

type MediaItem = {
  type?: string
  show?: { title: string }
  [key: string]: unknown
}

// One slim row per item: enough to find or count titles and to act on them by
// trakt id, plus the tool's own date/count fields (e.g. listed_at, plays).
const compactItem = (item: MediaItem, keep: string[]) => {
  // Watched and collection items have no `type`; infer it from the media key.
  const type = item.type ?? (item.movie ? "movie" : "show")
  const media = item[type] as {
    title: string
    year?: number
    ids?: { imdb?: string; trakt?: number }
  }
  return {
    type,
    title: media.title,
    year: media.year ?? null,
    imdb: media.ids?.imdb ?? null,
    trakt: media.ids?.trakt ?? null,
    ...(item.show && type !== "show" ? { show: item.show.title } : {}),
    ...Object.fromEntries(keep.map((k) => [k, item[k] ?? null])),
  }
}

// Fetches every page of `path` (up to COMPACT_MAX_PAGES) and returns compact
// rows as minified JSON.
const compactList = async (path: string, keep: string[], failure: string) => {
  const items: ReturnType<typeof compactItem>[] = []
  let itemCount = 0
  let pageCount = 1
  for (let page = 1; page <= Math.min(pageCount, COMPACT_MAX_PAGES); page++) {
    const data = await apiFetchPage<MediaItem>(
      `${path}?${pageQuery(page, 100)}`,
    )
    if (!data) return err(failure)
    items.push(...data.items.map((i) => compactItem(i, keep)))
    pageCount = data.pagination?.pageCount ?? 1
    itemCount = data.pagination?.itemCount ?? items.length
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          items,
          itemCount,
          truncated: pageCount > COMPACT_MAX_PAGES,
        }),
      },
    ],
  }
}

const apiDelete = async (path: string): Promise<boolean> => {
  try {
    const response = await authedFetch(path, { method: "DELETE" })
    return response.ok
  } catch (error) {
    console.error(`Delete failed: ${path}`, error)
    return false
  }
}

export const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
})

export const err = (msg: string) => ({
  content: [{ type: "text" as const, text: `Error: ${msg}` }],
})

const today = () => new Date().toISOString().split("T")[0]!

// ─── Search ───

export const search = async ({
  query,
  type,
  limit,
}: {
  query: string
  type: "movie" | "show" | "episode" | "person" | "list"
  limit: number
}) => {
  const data = await apiFetch<unknown[]>(
    `/search/${type}?query=${encodeURIComponent(query)}&limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("search failed")
}

// ─── Movies ───

export const getMovie = async ({
  id,
  extended,
}: {
  id: string
  extended: boolean
}) => {
  const params = extended ? "?extended=full" : ""
  const data = await apiFetch<unknown>(`/movies/${id}${params}`)
  return data ? ok(data) : err("movie not found")
}

export const getTrendingMovies = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/movies/trending?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch trending movies")
}

export const getPopularMovies = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/movies/popular?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch popular movies")
}

export const getAnticipatedMovies = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/movies/anticipated?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch anticipated movies")
}

export const getBoxofficeMovies = async () => {
  const data = await apiFetch<unknown[]>("/movies/boxoffice?extended=full")
  return data ? ok(data) : err("failed to fetch box office movies")
}

export const getMovieRatings = async ({ id }: { id: string }) => {
  const data = await apiFetch<unknown>(`/movies/${id}/ratings`)
  return data ? ok(data) : err("failed to fetch movie ratings")
}

export const getMovieRelated = async ({
  id,
  limit,
}: {
  id: string
  limit: number
}) => {
  const data = await apiFetch<unknown[]>(
    `/movies/${id}/related?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch related movies")
}

export const getMoviePeople = async ({ id }: { id: string }) => {
  const data = await apiFetch<unknown>(`/movies/${id}/people?extended=full`)
  return data ? ok(data) : err("failed to fetch movie people")
}

// ─── Shows ───

export const getShow = async ({
  id,
  extended,
}: {
  id: string
  extended: boolean
}) => {
  const params = extended ? "?extended=full" : ""
  const data = await apiFetch<unknown>(`/shows/${id}${params}`)
  return data ? ok(data) : err("show not found")
}

export const getTrendingShows = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/shows/trending?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch trending shows")
}

export const getPopularShows = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/shows/popular?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch popular shows")
}

export const getAnticipatedShows = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/shows/anticipated?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch anticipated shows")
}

export const getShowRatings = async ({ id }: { id: string }) => {
  const data = await apiFetch<unknown>(`/shows/${id}/ratings`)
  return data ? ok(data) : err("failed to fetch show ratings")
}

export const getShowSeasons = async ({
  id,
  with_episodes,
}: {
  id: string
  with_episodes: boolean
}) => {
  const extended = with_episodes ? "?extended=full,episodes" : "?extended=full"
  const data = await apiFetch<unknown[]>(`/shows/${id}/seasons${extended}`)
  return data ? ok(data) : err("failed to fetch seasons")
}

export const getShowPeople = async ({ id }: { id: string }) => {
  const data = await apiFetch<unknown>(`/shows/${id}/people?extended=full`)
  return data ? ok(data) : err("failed to fetch show people")
}

export const getShowRelated = async ({
  id,
  limit,
}: {
  id: string
  limit: number
}) => {
  const data = await apiFetch<unknown[]>(
    `/shows/${id}/related?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch related shows")
}

// ─── Episodes ───

export const getSeasonEpisodes = async ({
  id,
  season,
}: {
  id: string
  season: number
}) => {
  const data = await apiFetch<unknown[]>(
    `/shows/${id}/seasons/${season}?extended=full`,
  )
  return data ? ok(data) : err("failed to fetch episodes")
}

export const getEpisode = async ({
  id,
  season,
  episode,
}: {
  id: string
  season: number
  episode: number
}) => {
  const data = await apiFetch<unknown>(
    `/shows/${id}/seasons/${season}/episodes/${episode}?extended=full`,
  )
  return data ? ok(data) : err("episode not found")
}

// ─── People ───

export const getPerson = async ({ id }: { id: string }) => {
  const data = await apiFetch<unknown>(`/people/${id}?extended=full`)
  return data ? ok(data) : err("person not found")
}

export const getPersonCredits = async ({
  id,
  type,
}: {
  id: string
  type: "movies" | "shows"
}) => {
  const data = await apiFetch<unknown>(`/people/${id}/${type}?extended=full`)
  return data ? ok(data) : err("failed to fetch credits")
}

// ─── Calendar ───

export const getMyShowCalendar = async ({
  start_date,
  days,
}: {
  start_date?: string
  days: number
}) => {
  const data = await apiFetch<unknown>(
    `/calendars/my/shows/${start_date ?? today()}/${days}`,
  )
  return data ? ok(data) : err("failed to fetch show calendar")
}

export const getMyMovieCalendar = async ({
  start_date,
  days,
}: {
  start_date?: string
  days: number
}) => {
  const data = await apiFetch<unknown>(
    `/calendars/my/movies/${start_date ?? today()}/${days}`,
  )
  return data ? ok(data) : err("failed to fetch movie calendar")
}

export const getAllShowCalendar = async ({
  start_date,
  days,
}: {
  start_date?: string
  days: number
}) => {
  const data = await apiFetch<unknown>(
    `/calendars/all/shows/${start_date ?? today()}/${days}`,
  )
  return data ? ok(data) : err("failed to fetch calendar")
}

export const getAllMovieCalendar = async ({
  start_date,
  days,
}: {
  start_date?: string
  days: number
}) => {
  const data = await apiFetch<unknown>(
    `/calendars/all/movies/${start_date ?? today()}/${days}`,
  )
  return data ? ok(data) : err("failed to fetch movie calendar")
}

// ─── History ───

export const getHistory = async ({
  type,
  limit,
  page,
}: {
  type?: "movies" | "shows" | "episodes"
  limit: number
  page: number
}) => {
  const path = type ? `/sync/history/${type}` : "/sync/history"
  const data = await apiFetchPage<unknown>(
    `${path}?${pageQuery(page, limit)}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch history")
}

export const addToHistory = async ({
  movies,
  episodes,
}: {
  movies?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/history", {
    method: "POST",
    body: JSON.stringify({ movies: movies ?? [], episodes: episodes ?? [] }),
  })
  return data ? ok(data) : err("failed to add to history")
}

export const removeFromHistory = async ({
  movies,
  episodes,
}: {
  movies?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/history/remove", {
    method: "POST",
    body: JSON.stringify({ movies: movies ?? [], episodes: episodes ?? [] }),
  })
  return data ? ok(data) : err("failed to remove from history")
}

// ─── Collection ───

export const getCollectionMovies = async ({
  extended,
  page,
  limit,
  compact,
}: {
  extended: boolean
  page: number
  limit: number
  compact?: boolean
}) => {
  if (compact)
    return compactList(
      "/sync/collection/movies",
      ["collected_at"],
      "failed to fetch movie collection",
    )
  const params = extended ? "&extended=full" : ""
  const data = await apiFetchPage<unknown>(
    `/sync/collection/movies?${pageQuery(page, limit)}${params}`,
  )
  return data ? ok(data) : err("failed to fetch movie collection")
}

export const getCollectionShows = async ({
  extended,
  page,
  limit,
  compact,
}: {
  extended: boolean
  page: number
  limit: number
  compact?: boolean
}) => {
  if (compact)
    return compactList(
      "/sync/collection/shows",
      ["last_collected_at"],
      "failed to fetch show collection",
    )
  const params = extended ? "&extended=full" : ""
  const data = await apiFetchPage<unknown>(
    `/sync/collection/shows?${pageQuery(page, limit)}${params}`,
  )
  return data ? ok(data) : err("failed to fetch show collection")
}

export const addToCollection = async ({
  movies,
  shows,
  episodes,
}: {
  movies?: unknown[]
  shows?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/collection", {
    method: "POST",
    body: JSON.stringify({
      movies: movies ?? [],
      shows: shows ?? [],
      episodes: episodes ?? [],
    }),
  })
  return data ? ok(data) : err("failed to add to collection")
}

export const removeFromCollection = async ({
  movies,
  shows,
  episodes,
}: {
  movies?: unknown[]
  shows?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/collection/remove", {
    method: "POST",
    body: JSON.stringify({
      movies: movies ?? [],
      shows: shows ?? [],
      episodes: episodes ?? [],
    }),
  })
  return data ? ok(data) : err("failed to remove from collection")
}

// ─── Watched ───

export const getWatchedMovies = async ({
  extended,
  page,
  limit,
  compact,
}: {
  extended: boolean
  page: number
  limit: number
  compact?: boolean
}) => {
  if (compact)
    return compactList(
      "/sync/watched/movies",
      ["plays", "last_watched_at"],
      "failed to fetch watched movies",
    )
  const params = extended ? "&extended=full" : ""
  const data = await apiFetchPage<unknown>(
    `/sync/watched/movies?${pageQuery(page, limit)}${params}`,
  )
  return data ? ok(data) : err("failed to fetch watched movies")
}

export const getWatchedShows = async ({
  extended,
  page,
  limit,
  compact,
}: {
  extended: boolean
  page: number
  limit: number
  compact?: boolean
}) => {
  if (compact)
    return compactList(
      "/sync/watched/shows",
      ["plays", "last_watched_at"],
      "failed to fetch watched shows",
    )
  const params = extended ? "&extended=full" : ""
  const data = await apiFetchPage<unknown>(
    `/sync/watched/shows?${pageQuery(page, limit)}${params}`,
  )
  return data ? ok(data) : err("failed to fetch watched shows")
}

// ─── Playback ───

export const getPlayback = async ({
  type,
}: {
  type?: "movies" | "episodes"
}) => {
  const path = type ? `/sync/playback/${type}` : "/sync/playback"
  const data = await apiFetch<unknown[]>(path)
  return data ? ok(data) : err("failed to fetch playback progress")
}

export const deletePlayback = async ({
  id,
  confirm,
}: {
  id: number
  confirm: boolean
}) => {
  if (!confirm) return err("set confirm: true to delete playback progress")
  const success = await apiDelete(`/sync/playback/${id}`)
  return success ? ok({ success: true }) : err(`delete playback failed`)
}

// ─── Sync ───

export const getSyncLastActivities = async () => {
  const data = await apiFetch<unknown>("/sync/last_activities")
  return data ? ok(data) : err("failed to fetch last activities")
}

// ─── Ratings ───

export const getRatings = async ({
  type,
  rating,
}: {
  type?: "movies" | "shows" | "episodes" | "seasons"
  rating?: number
}) => {
  const path = type ? `/sync/ratings/${type}` : "/sync/ratings"
  const ratingFilter = rating ? `/${rating}` : ""
  const data = await apiFetch<unknown[]>(`${path}${ratingFilter}?extended=full`)
  return data ? ok(data) : err("failed to fetch ratings")
}

export const addRating = async ({
  movies,
  shows,
  episodes,
}: {
  movies?: unknown[]
  shows?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/ratings", {
    method: "POST",
    body: JSON.stringify({
      movies: movies ?? [],
      shows: shows ?? [],
      episodes: episodes ?? [],
    }),
  })
  return data ? ok(data) : err("failed to add ratings")
}

export const removeRating = async ({
  movies,
  shows,
  episodes,
}: {
  movies?: unknown[]
  shows?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/ratings/remove", {
    method: "POST",
    body: JSON.stringify({
      movies: movies ?? [],
      shows: shows ?? [],
      episodes: episodes ?? [],
    }),
  })
  return data ? ok(data) : err("failed to remove ratings")
}

// ─── Watchlist ───

export const getWatchlist = async ({
  type,
  sort,
  page,
  limit,
  compact,
}: {
  type?: "movies" | "shows" | "episodes" | "seasons"
  sort: string
  page: number
  limit: number
  compact?: boolean
}) => {
  const path = type ? `/sync/watchlist/${type}/${sort}` : "/sync/watchlist"
  if (compact)
    return compactList(path, ["listed_at"], "failed to fetch watchlist")
  const data = await apiFetchPage<unknown>(
    `${path}?${pageQuery(page, limit)}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch watchlist")
}

export const addToWatchlist = async ({
  movies,
  shows,
  episodes,
}: {
  movies?: unknown[]
  shows?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/watchlist", {
    method: "POST",
    body: JSON.stringify({
      movies: movies ?? [],
      shows: shows ?? [],
      episodes: episodes ?? [],
    }),
  })
  return data ? ok(data) : err("failed to add to watchlist")
}

export const removeFromWatchlist = async ({
  movies,
  shows,
  episodes,
}: {
  movies?: unknown[]
  shows?: unknown[]
  episodes?: unknown[]
}) => {
  const data = await apiFetch<unknown>("/sync/watchlist/remove", {
    method: "POST",
    body: JSON.stringify({
      movies: movies ?? [],
      shows: shows ?? [],
      episodes: episodes ?? [],
    }),
  })
  return data ? ok(data) : err("failed to remove from watchlist")
}

// ─── Checkin ───

export const checkin = async ({
  movie,
  episode,
  message,
}: {
  movie?: unknown
  episode?: unknown
  message?: string
}) => {
  const body: Record<string, unknown> = {}
  if (movie) body.movie = movie
  if (episode) body.episode = episode
  if (message) body.message = message
  const data = await apiFetch<unknown>("/checkin", {
    method: "POST",
    body: JSON.stringify(body),
  })
  if (!data)
    return err(
      "checkin failed — you may already be checked in, or the item was not found",
    )
  return ok(data)
}

export const deleteCheckin = async ({ confirm }: { confirm: boolean }) => {
  if (!confirm) return err("set confirm: true to cancel the active checkin")
  const success = await apiDelete("/checkin")
  return success ? ok({ success: true }) : err("delete checkin failed")
}

// ─── Scrobble ───

export const scrobbleStart = async ({
  movie,
  episode,
  show,
  progress,
}: {
  movie?: unknown
  episode?: unknown
  show?: unknown
  progress: number
}) => {
  const body: Record<string, unknown> = { progress }
  if (movie) body.movie = movie
  if (episode) body.episode = episode
  if (show) body.show = show
  const data = await apiFetch<unknown>("/scrobble/start", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return data ? ok(data) : err("scrobble start failed")
}

export const scrobblePause = async ({
  movie,
  episode,
  show,
  progress,
}: {
  movie?: unknown
  episode?: unknown
  show?: unknown
  progress: number
}) => {
  const body: Record<string, unknown> = { progress }
  if (movie) body.movie = movie
  if (episode) body.episode = episode
  if (show) body.show = show
  const data = await apiFetch<unknown>("/scrobble/pause", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return data ? ok(data) : err("scrobble pause failed")
}

export const scrobbleStop = async ({
  movie,
  episode,
  show,
  progress,
}: {
  movie?: unknown
  episode?: unknown
  show?: unknown
  progress: number
}) => {
  const body: Record<string, unknown> = { progress }
  if (movie) body.movie = movie
  if (episode) body.episode = episode
  if (show) body.show = show
  const data = await apiFetch<unknown>("/scrobble/stop", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return data ? ok(data) : err("scrobble stop failed")
}

// ─── Recommendations ───

export const getMovieRecommendations = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/recommendations/movies?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch movie recommendations")
}

export const getShowRecommendations = async ({ limit }: { limit: number }) => {
  const data = await apiFetch<unknown[]>(
    `/recommendations/shows?limit=${limit}&extended=full`,
  )
  return data ? ok(data) : err("failed to fetch show recommendations")
}

// ─── User ───

export const getUserProfile = async ({ username }: { username: string }) => {
  const data = await apiFetch<unknown>(`/users/${username}?extended=full`)
  return data ? ok(data) : err("user not found")
}

export const getUserStats = async ({ username }: { username: string }) => {
  const data = await apiFetch<unknown>(`/users/${username}/stats`)
  return data ? ok(data) : err("failed to fetch user stats")
}

export const getUserWatching = async ({ username }: { username: string }) => {
  const data = await apiFetch<unknown>(`/users/${username}/watching`)
  return data ? ok(data) : err("user is not currently watching anything")
}

// ─── Server ───

const server = new McpServer({ name: "trakt", version: "1.0.0" })

// ─── Search ───

server.registerTool(
  "search",
  {
    description:
      "Search for movies, shows, episodes, people, or lists on Trakt",
    inputSchema: {
      query: z.string().describe("Search query"),
      type: z
        .enum(["movie", "show", "episode", "person", "list"])
        .default("movie")
        .describe("Type of content to search"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Number of results to return"),
    },
  },
  search,
)

// ─── Movies ───

server.registerTool(
  "get_movie",
  {
    description: "Get detailed information about a movie",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
      extended: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include full info"),
    },
  },
  getMovie,
)

server.registerTool(
  "get_trending_movies",
  {
    description: "Get movies currently being watched across Trakt",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getTrendingMovies,
)

server.registerTool(
  "get_popular_movies",
  {
    description: "Get the most popular movies on Trakt",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getPopularMovies,
)

server.registerTool(
  "get_anticipated_movies",
  {
    description: "Get the most anticipated movies based on watchlist activity",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getAnticipatedMovies,
)

server.registerTool(
  "get_boxoffice_movies",
  {
    description: "Get the top 10 weekend box office movies updated weekly",
    inputSchema: {},
  },
  getBoxofficeMovies,
)

server.registerTool(
  "get_movie_ratings",
  {
    description: "Get community rating distribution for a movie",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
    },
  },
  getMovieRatings,
)

server.registerTool(
  "get_movie_related",
  {
    description: "Get movies related to a given movie",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
      limit: z.number().optional().default(10),
    },
  },
  getMovieRelated,
)

server.registerTool(
  "get_movie_people",
  {
    description: "Get cast and crew for a movie",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
    },
  },
  getMoviePeople,
)

// ─── Shows ───

server.registerTool(
  "get_show",
  {
    description: "Get detailed information about a TV show",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
      extended: z.boolean().optional().default(true),
    },
  },
  getShow,
)

server.registerTool(
  "get_trending_shows",
  {
    description: "Get TV shows currently being watched across Trakt",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getTrendingShows,
)

server.registerTool(
  "get_popular_shows",
  {
    description: "Get the most popular TV shows on Trakt",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getPopularShows,
)

server.registerTool(
  "get_anticipated_shows",
  {
    description:
      "Get the most anticipated TV shows based on watchlist activity",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getAnticipatedShows,
)

server.registerTool(
  "get_show_ratings",
  {
    description: "Get community rating distribution for a TV show",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
    },
  },
  getShowRatings,
)

server.registerTool(
  "get_show_seasons",
  {
    description:
      "Get all seasons for a TV show, optionally with full episode details",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
      with_episodes: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include episode list per season"),
    },
  },
  getShowSeasons,
)

server.registerTool(
  "get_show_people",
  {
    description: "Get cast and crew for a TV show",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
    },
  },
  getShowPeople,
)

server.registerTool(
  "get_show_related",
  {
    description: "Get TV shows related to a given show",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB/TMDB ID"),
      limit: z.number().optional().default(10),
    },
  },
  getShowRelated,
)

// ─── Episodes ───

server.registerTool(
  "get_season_episodes",
  {
    description: "Get all episodes in a specific season of a TV show",
    inputSchema: {
      id: z.string().describe("Show Trakt ID or slug"),
      season: z.number().describe("Season number"),
    },
  },
  getSeasonEpisodes,
)

server.registerTool(
  "get_episode",
  {
    description: "Get full details for a specific episode of a TV show",
    inputSchema: {
      id: z.string().describe("Show Trakt ID or slug"),
      season: z.number().describe("Season number"),
      episode: z.number().describe("Episode number"),
    },
  },
  getEpisode,
)

// ─── People ───

server.registerTool(
  "get_person",
  {
    description: "Get details about a person (actor, director, etc.)",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB ID"),
    },
  },
  getPerson,
)

server.registerTool(
  "get_person_credits",
  {
    description: "Get movie or show credits for a person",
    inputSchema: {
      id: z.string().describe("Trakt ID, slug, or IMDB ID"),
      type: z.enum(["movies", "shows"]).default("movies"),
    },
  },
  getPersonCredits,
)

// ─── Calendar ───

server.registerTool(
  "get_my_show_calendar",
  {
    description: "Get my upcoming show episodes based on shows I watch",
    inputSchema: {
      start_date: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD, defaults to today"),
      days: z.number().optional().default(7).describe("Number of days ahead"),
    },
  },
  getMyShowCalendar,
)

server.registerTool(
  "get_my_movie_calendar",
  {
    description: "Get my upcoming movies based on movies in my watchlist",
    inputSchema: {
      start_date: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD, defaults to today"),
      days: z.number().optional().default(7),
    },
  },
  getMyMovieCalendar,
)

server.registerTool(
  "get_all_show_calendar",
  {
    description: "Get all shows premiering and airing across all Trakt users",
    inputSchema: {
      start_date: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD, defaults to today"),
      days: z.number().optional().default(7),
    },
  },
  getAllShowCalendar,
)

server.registerTool(
  "get_all_movie_calendar",
  {
    description: "Get all movies releasing across all Trakt users",
    inputSchema: {
      start_date: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD, defaults to today"),
      days: z.number().optional().default(7),
    },
  },
  getAllMovieCalendar,
)

// ─── History ───

server.registerTool(
  "get_history",
  {
    description:
      "Get watch history for the authenticated user, one page at a time",
    inputSchema: {
      type: z
        .enum(["movies", "shows", "episodes"])
        .optional()
        .describe("Filter by content type"),
      ...pageInput(20),
    },
  },
  getHistory,
)

server.registerTool(
  "add_to_history",
  {
    description: "Mark movies or episodes as watched",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
              tmdb: z.number().optional(),
            }),
            watched_at: z
              .string()
              .optional()
              .describe("ISO 8601 datetime — defaults to now if omitted"),
          }),
        )
        .optional(),
      episodes: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              tvdb: z.number().optional(),
            }),
            watched_at: z.string().optional(),
          }),
        )
        .optional(),
    },
  },
  addToHistory,
)

server.registerTool(
  "remove_from_history",
  {
    description: "Remove items from watch history",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(z.object({ ids: z.object({ trakt: z.number().optional() }) }))
        .optional(),
    },
  },
  removeFromHistory,
)

// ─── Collection ───

server.registerTool(
  "get_collection_movies",
  {
    description:
      "Get movies in the authenticated user's collection, one page at a time",
    inputSchema: {
      extended: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include full movie info"),
      ...pageInput(100),
      ...compactInput,
    },
  },
  getCollectionMovies,
)

server.registerTool(
  "get_collection_shows",
  {
    description:
      "Get shows in the authenticated user's collection, one page at a time",
    inputSchema: {
      extended: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include full show info"),
      ...pageInput(100),
      ...compactInput,
    },
  },
  getCollectionShows,
)

server.registerTool(
  "add_to_collection",
  {
    description: "Add movies, shows, or episodes to the user's collection",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
              tmdb: z.number().optional(),
            }),
            collected_at: z.string().optional(),
            media_type: z.string().optional(),
            resolution: z.string().optional(),
          }),
        )
        .optional(),
      shows: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(z.object({ ids: z.object({ trakt: z.number().optional() }) }))
        .optional(),
    },
  },
  addToCollection,
)

server.registerTool(
  "remove_from_collection",
  {
    description: "Remove movies, shows, or episodes from the user's collection",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      shows: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(z.object({ ids: z.object({ trakt: z.number().optional() }) }))
        .optional(),
    },
  },
  removeFromCollection,
)

// ─── Watched ───

server.registerTool(
  "get_watched_movies",
  {
    description:
      "Get movies the authenticated user has watched with play counts, one page at a time",
    inputSchema: {
      extended: z.boolean().optional().default(true),
      ...pageInput(100),
      ...compactInput,
    },
  },
  getWatchedMovies,
)

server.registerTool(
  "get_watched_shows",
  {
    description:
      "Get shows the authenticated user has watched with play counts per episode, one page at a time",
    inputSchema: {
      extended: z.boolean().optional().default(true),
      ...pageInput(100),
      ...compactInput,
    },
  },
  getWatchedShows,
)

// ─── Playback ───

server.registerTool(
  "get_playback",
  {
    description:
      "Get paused playback progress for movies or episodes to resume later",
    inputSchema: {
      type: z
        .enum(["movies", "episodes"])
        .optional()
        .describe("Filter by content type"),
    },
  },
  getPlayback,
)

server.registerTool(
  "delete_playback",
  {
    description: "Delete a paused playback entry",
    inputSchema: {
      id: z.number().describe("Playback ID to delete"),
      confirm: z
        .boolean()
        .default(false)
        .describe("Set to true to confirm deletion"),
    },
  },
  deletePlayback,
)

// ─── Sync ───

server.registerTool(
  "get_sync_last_activities",
  {
    description:
      "Get timestamps for when each resource was last updated — useful for syncing only changed data",
    inputSchema: {},
  },
  getSyncLastActivities,
)

// ─── Ratings ───

server.registerTool(
  "get_ratings",
  {
    description: "Get ratings given by the authenticated user",
    inputSchema: {
      type: z
        .enum(["movies", "shows", "episodes", "seasons"])
        .optional()
        .describe("Filter by content type"),
      rating: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("Filter by specific rating value"),
    },
  },
  getRatings,
)

server.registerTool(
  "add_rating",
  {
    description: "Rate movies, shows, seasons, or episodes (1–10)",
    inputSchema: {
      movies: z
        .array(
          z.object({
            rating: z.number().min(1).max(10),
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
              tmdb: z.number().optional(),
            }),
          }),
        )
        .optional(),
      shows: z
        .array(
          z.object({
            rating: z.number().min(1).max(10),
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(
          z.object({
            rating: z.number().min(1).max(10),
            ids: z.object({ trakt: z.number().optional() }),
          }),
        )
        .optional(),
    },
  },
  addRating,
)

server.registerTool(
  "remove_rating",
  {
    description: "Remove ratings from movies, shows, or episodes",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      shows: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(z.object({ ids: z.object({ trakt: z.number().optional() }) }))
        .optional(),
    },
  },
  removeRating,
)

// ─── Watchlist ───

server.registerTool(
  "get_watchlist",
  {
    description: "Get the authenticated user's watchlist, one page at a time",
    inputSchema: {
      type: z.enum(["movies", "shows", "episodes", "seasons"]).optional(),
      sort: z
        .enum([
          "rank",
          "added",
          "title",
          "released",
          "runtime",
          "popularity",
          "percentage",
          "votes",
        ])
        .optional()
        .default("rank"),
      ...pageInput(100),
      ...compactInput,
    },
  },
  getWatchlist,
)

server.registerTool(
  "add_to_watchlist",
  {
    description: "Add movies, shows, or episodes to the watchlist",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
              tmdb: z.number().optional(),
            }),
          }),
        )
        .optional(),
      shows: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(z.object({ ids: z.object({ trakt: z.number().optional() }) }))
        .optional(),
    },
  },
  addToWatchlist,
)

server.registerTool(
  "remove_from_watchlist",
  {
    description: "Remove movies, shows, or episodes from the watchlist",
    inputSchema: {
      movies: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      shows: z
        .array(
          z.object({
            ids: z.object({
              trakt: z.number().optional(),
              imdb: z.string().optional(),
            }),
          }),
        )
        .optional(),
      episodes: z
        .array(z.object({ ids: z.object({ trakt: z.number().optional() }) }))
        .optional(),
    },
  },
  removeFromWatchlist,
)

// ─── Checkin ───

server.registerTool(
  "checkin",
  {
    description: "Check in to a movie or episode you are watching right now",
    inputSchema: {
      movie: z
        .object({
          ids: z.object({
            trakt: z.number().optional(),
            imdb: z.string().optional(),
            tmdb: z.number().optional(),
          }),
        })
        .optional()
        .describe("Movie to check in to (mutually exclusive with episode)"),
      episode: z
        .object({
          ids: z.object({
            trakt: z.number().optional(),
            tvdb: z.number().optional(),
          }),
        })
        .optional()
        .describe("Episode to check in to (mutually exclusive with movie)"),
      message: z.string().optional().describe("Optional shout message"),
    },
  },
  checkin,
)

server.registerTool(
  "delete_checkin",
  {
    description: "Cancel the current active checkin",
    inputSchema: {
      confirm: z
        .boolean()
        .default(false)
        .describe("Set to true to confirm cancellation"),
    },
  },
  deleteCheckin,
)

// ─── Scrobble ───

const scrobbleSchema = {
  movie: z
    .object({
      title: z.string().optional(),
      year: z.number().optional(),
      ids: z.object({
        trakt: z.number().optional(),
        imdb: z.string().optional(),
        tmdb: z.number().optional(),
      }),
    })
    .optional()
    .describe("Movie to scrobble (mutually exclusive with episode)"),
  episode: z
    .object({
      season: z.number().optional(),
      number: z.number().optional(),
      ids: z.object({
        trakt: z.number().optional(),
        tvdb: z.number().optional(),
      }),
    })
    .optional()
    .describe("Episode to scrobble (mutually exclusive with movie)"),
  show: z
    .object({
      title: z.string().optional(),
      ids: z.object({
        trakt: z.number().optional(),
        imdb: z.string().optional(),
      }),
    })
    .optional()
    .describe("Show context when scrobbling an episode"),
  progress: z
    .number()
    .min(0)
    .max(100)
    .describe("Playback progress percentage (0–100)"),
}

server.registerTool(
  "scrobble_start",
  {
    description:
      "Start scrobbling — call when playback begins to track what you are watching",
    inputSchema: scrobbleSchema,
  },
  scrobbleStart,
)

server.registerTool(
  "scrobble_pause",
  {
    description:
      "Pause scrobbling — call when playback is paused to save progress",
    inputSchema: scrobbleSchema,
  },
  scrobblePause,
)

server.registerTool(
  "scrobble_stop",
  {
    description:
      "Stop scrobbling — call when playback ends to record the watch",
    inputSchema: scrobbleSchema,
  },
  scrobbleStop,
)

// ─── Recommendations ───

server.registerTool(
  "get_movie_recommendations",
  {
    description:
      "Get personalized movie recommendations for the authenticated user",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getMovieRecommendations,
)

server.registerTool(
  "get_show_recommendations",
  {
    description:
      "Get personalized TV show recommendations for the authenticated user",
    inputSchema: {
      limit: z.number().optional().default(10),
    },
  },
  getShowRecommendations,
)

// ─── User ───

server.registerTool(
  "get_user_profile",
  {
    description:
      "Get profile information for a user (defaults to authenticated user)",
    inputSchema: {
      username: z
        .string()
        .optional()
        .default("me")
        .describe("Trakt username, or 'me' for the authenticated user"),
    },
  },
  getUserProfile,
)

server.registerTool(
  "get_user_stats",
  {
    description: "Get watch statistics for a user",
    inputSchema: {
      username: z.string().optional().default("me"),
    },
  },
  getUserStats,
)

server.registerTool(
  "get_user_watching",
  {
    description: "Get what a user is currently watching",
    inputSchema: {
      username: z.string().optional().default("me"),
    },
  },
  getUserWatching,
)

const main = async () => {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("mcp-trakt running")
}

if (!runningUnderTest) {
  main().catch((error) => {
    console.error("Fatal:", error)
    process.exit(1)
  })
}
