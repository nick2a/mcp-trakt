import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it } from "vitest"
import { server } from "../index.js"

// What an MCP client (e.g. Claude Code) sees in tools/list.
const listTools = async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

const compactTools = [
  "get_collection_movies",
  "get_collection_shows",
  "get_watched_movies",
  "get_watched_shows",
  "get_watchlist",
]

describe("tools/list", () => {
  it("lets compact-capable tools return up to 150,000 characters inline", async () => {
    const tools = await listTools()
    const raised = tools
      .filter((t) => t._meta?.["anthropic/maxResultSizeChars"] === 150_000)
      .map((t) => t.name)
      .sort()
    expect(raised).toEqual(compactTools)
    // Every tool that offers compact declares the limit, and nothing else does.
    const withCompact = tools
      .filter((t) => "compact" in (t.inputSchema.properties ?? {}))
      .map((t) => t.name)
      .sort()
    expect(withCompact).toEqual(compactTools)
  })
})
