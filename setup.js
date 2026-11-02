#!/usr/bin/env node
// One-time Trakt sign-in using OAuth 2.0 Authorization Code + PKCE.
// No client secret is needed; tokens go straight to the macOS Keychain and are
// never printed. The Trakt app's redirect URI must be exactly REDIRECT_URI.
import { createInterface } from "readline"
import { execFileSync } from "child_process"
import { createHash, randomBytes } from "crypto"
import { createServer } from "http"

const KEYCHAIN_SERVICE = "mcp-trakt"
const API_BASE = "https://api.trakt.tv"
const AUTHORIZE_URL = "https://auth.trakt.tv/oauth/authorize"
const PORT = 8080
const REDIRECT_URI = `http://localhost:${PORT}/callback`

const keychainRead = (account) => {
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

const keychainWrite = (account, value) =>
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

// Resolves with the authorization code once Trakt redirects back to us.
const waitForCode = (state) =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI)
      if (url.pathname !== "/callback") {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get("error")
      const code = url.searchParams.get("code")
      server.close()
      if (error) {
        res.writeHead(400).end("Trakt sign-in was not approved.")
        reject(new Error(`Authorization failed: ${error}`))
      } else if (url.searchParams.get("state") !== state || !code) {
        res.writeHead(400).end("Sign-in failed: state mismatch or missing code.")
        reject(new Error("State mismatch or missing code"))
      } else {
        res.writeHead(200).end("Signed in to Trakt. You can close this tab.")
        resolve(code)
      }
    })
    server.on("error", reject)
    server.listen(PORT, "localhost")
  })

const existingClientId = keychainRead("client-id")

console.log("Trakt MCP Setup")
console.log("───────────────")
console.log("Your apps: https://trakt.tv/oauth/applications")
console.log(`The app's redirect URI must be: ${REDIRECT_URI}\n`)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const clientId =
  (
    await new Promise((resolve) =>
      rl.question(
        `Client ID${existingClientId ? ` [${existingClientId.slice(0, 8)}…]` : ""}: `,
        resolve,
      ),
    )
  ).trim() || existingClientId
rl.close()

if (!clientId) {
  console.error("A client ID is required.")
  process.exit(1)
}

// PKCE: verifier is 64 base64url chars (43–128 allowed); challenge is its SHA-256.
const verifier = randomBytes(48).toString("base64url")
const challenge = createHash("sha256").update(verifier).digest("base64url")
const state = randomBytes(16).toString("base64url")

const authUrl = new URL(AUTHORIZE_URL)
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString()

const codePromise = waitForCode(state)
console.log(`\nApprove access in your browser:\n${authUrl.href}\n`)
try {
  execFileSync("open", [authUrl.href])
} catch {
  // Not fatal: the URL is printed above.
}

const code = await codePromise

const res = await fetch(`${API_BASE}/oauth/token`, {
  method: "POST",
  headers: {
    "User-Agent": "mcp-trakt",
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
  },
  body: JSON.stringify({
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
    code_verifier: verifier,
  }),
})

if (!res.ok) {
  // Only the status: the body is not printed in case it echoes credentials.
  console.error(`Token exchange failed: ${res.status} ${res.statusText}`)
  process.exit(1)
}

const token = await res.json()
keychainWrite("client-id", clientId)
keychainWrite("access-token", token.access_token)
keychainWrite("refresh-token", token.refresh_token)

console.log(`Saved to macOS Keychain (${KEYCHAIN_SERVICE}).`)
console.log("Setup complete.")
