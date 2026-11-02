import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// In-memory stand-in for the macOS Keychain, so these tests never touch the real one.
const keychain = vi.hoisted(() => new Map<string, string>())

vi.mock("child_process", () => ({
  execFileSync: (_cmd: string, args: string[]) => {
    const account = args[args.indexOf("-a") + 1]
    if (args[0] === "add-generic-password") {
      keychain.set(account, args[args.indexOf("-w") + 1])
      return Buffer.from("")
    }
    const value = keychain.get(account)
    if (value === undefined) throw new Error("not found")
    return Buffer.from(value)
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

const TOKEN_URL = "https://api.trakt.tv/oauth/token"

const respond = (status: number, data: unknown = {}) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(data),
  })

// Trakt stand-in: only `validToken` is accepted; the token endpoint answers with
// `tokenStatus`, rotating to new-access / new-refresh on success.
const trakt = (validToken: string, tokenStatus = 200) =>
  mockFetch.mockImplementation((url: string, init: RequestInit) => {
    if (url === TOKEN_URL)
      return respond(tokenStatus, {
        access_token: "new-access",
        refresh_token: "new-refresh",
      })
    const auth = (init.headers as Record<string, string>).Authorization
    return auth === `Bearer ${validToken}`
      ? respond(200, [{ movie: { title: "Inception" } }])
      : respond(401)
  })

const tokenCalls = () => mockFetch.mock.calls.filter(([url]) => url === TOKEN_URL)

const loadServer = async () => {
  vi.resetModules()
  return import("../index.js")
}

beforeEach(() => {
  mockFetch.mockReset()
  keychain.clear()
  keychain.set("client-id", "cid")
  keychain.set("access-token", "old-access")
  keychain.set("refresh-token", "old-refresh")
})

afterEach(() => {
  delete process.env.MCP_TRAKT_ACCESS_TOKEN
})

describe("token refresh on 401", () => {
  it("refreshes without a client secret, stores the rotated pair, and retries", async () => {
    const api = await loadServer()
    trakt("new-access")

    const result = await api.search({ query: "x", type: "movie", limit: 1 })

    expect(result.content[0].text).toContain("Inception")
    expect(tokenCalls()).toHaveLength(1)
    expect(JSON.parse(tokenCalls()[0][1].body)).toEqual({
      refresh_token: "old-refresh",
      client_id: "cid",
      redirect_uri: "http://localhost:8080/callback",
      grant_type: "refresh_token",
    })
    expect(keychain.get("access-token")).toBe("new-access")
    expect(keychain.get("refresh-token")).toBe("new-refresh")
  })

  it("adopts a token another process already refreshed instead of spending a refresh", async () => {
    const api = await loadServer()
    keychain.set("access-token", "other-process-access")
    trakt("other-process-access")

    const result = await api.search({ query: "x", type: "movie", limit: 1 })

    expect(result.content[0].text).toContain("Inception")
    expect(tokenCalls()).toHaveLength(0)
  })

  it("shares one refresh between concurrent requests", async () => {
    const api = await loadServer()
    trakt("new-access")

    const results = await Promise.all([
      api.search({ query: "a", type: "movie", limit: 1 }),
      api.search({ query: "b", type: "movie", limit: 1 }),
    ])

    for (const r of results) expect(r.content[0].text).toContain("Inception")
    expect(tokenCalls()).toHaveLength(1)
  })

  it("does not refresh again for a 401 that arrives after a refresh finished", async () => {
    const api = await loadServer()
    // Both A and B are sent with old-access; B's 401 is held back until A's
    // refresh has completed.
    let releaseB!: () => void
    const bRejected = new Promise<void>((r) => (releaseB = r))
    let rejections = 0
    mockFetch.mockImplementation((url: string, init: RequestInit) => {
      if (url === TOKEN_URL)
        return respond(200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
        })
      const auth = (init.headers as Record<string, string>).Authorization
      if (auth === "Bearer new-access")
        return respond(200, [{ movie: { title: "Inception" } }])
      rejections++
      return rejections === 2 ? bRejected.then(() => respond(401)) : respond(401)
    })

    const a = api.search({ query: "a", type: "movie", limit: 1 })
    const b = api.search({ query: "b", type: "movie", limit: 1 })
    await a
    releaseB()

    expect((await b).content[0].text).toContain("Inception")
    expect(tokenCalls()).toHaveLength(1)
  })

  it("gives up after one failed refresh and leaves the Keychain unchanged", async () => {
    const api = await loadServer()
    trakt("never-valid", 400)

    const result = await api.search({ query: "x", type: "movie", limit: 1 })

    expect(result.content[0].text).toContain("Error:")
    expect(mockFetch).toHaveBeenCalledTimes(2) // request + refresh, no retry
    expect(keychain.get("access-token")).toBe("old-access")
    expect(keychain.get("refresh-token")).toBe("old-refresh")
  })

  it("refreshes for DELETE requests too", async () => {
    const api = await loadServer()
    trakt("new-access")

    const result = await api.deleteCheckin({ confirm: true })

    expect(result.content[0].text).toContain("success")
    expect(tokenCalls()).toHaveLength(1)
  })

  it("never refreshes when the token comes from MCP_TRAKT_ACCESS_TOKEN", async () => {
    process.env.MCP_TRAKT_ACCESS_TOKEN = "env-access"
    const api = await loadServer()
    trakt("new-access")

    const result = await api.search({ query: "x", type: "movie", limit: 1 })

    expect(result.content[0].text).toContain("Error:")
    expect(tokenCalls()).toHaveLength(0)
    expect(keychain.get("refresh-token")).toBe("old-refresh")
  })
})
