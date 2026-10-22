# health-mcp

Remote, read-only, natural-language access to the `health_pi` Postgres database
(Peloton/Strava/Oura/Cronometer data), exposed as a remote MCP server reachable
from claude.ai (desktop or mobile) as a custom connector.

## Architecture

```
claude.ai (web/mobile)              Claude Code / curl / laptop
      │  OAuth 2.1 (DCR + PKCE)           │  static Bearer API key
      │  → Bearer <access_token>          │  → Bearer <MCP_API_KEY>
      ▼                                   ▼
              HTTPS, Streamable HTTP MCP transport
                          │
Cloudflare edge (TLS termination, DNS: health-mcp.michaelfigari.com)
      │  Cloudflare Tunnel (cloudflared, existing tunnel "health-webhook")
      ▼
Raspberry Pi — cloudflared.service
      │  proxies to http://localhost:8877 only (no public port opened)
      ▼
health-mcp.service (Node.js, express + @modelcontextprotocol/sdk)
      │  oauth.mjs: /.well-known/oauth-protected-resource (RFC9728),
      │             /.well-known/oauth-authorization-server (RFC8414),
      │             /register (RFC7591 DCR), /authorize, /token
      │  /mcp checks: Host header, then EITHER a valid OAuth access token
      │  OR the static MCP_API_KEY, then SQL is single SELECT/WITH
      ▼
Postgres (localhost:5432, database health_pi)
      │  role: claude_readonly — SELECT-only, default_transaction_read_only=on,
      │  no CONNECT on any other database, 5 connection cap
      ▼
health_pi tables (Peloton/Strava/Oura/Cronometer data)
```

The Cloudflare Tunnel (`18a4d3ef-25b8-4989-b22f-3f42264c2d5e`, named
`health-webhook`) already existed on this Pi for `webhook.michaelfigari.com`
and `jellyfin.michaelfigari.com`; this project added a third ingress rule
(`health-mcp.michaelfigari.com` → `localhost:8877`) to the same tunnel rather
than standing up a new one. No inbound port is opened on the Pi's firewall or
router — cloudflared makes an outbound-only connection to Cloudflare's edge.

## Data model summary (database: `health_pi`)

| Table | Rows (approx) | Purpose |
|---|---|---|
| `workout_summary` | 864 | Per-workout rollups: power, HR, speed, TSS, cadence, etc. Joined view `notion_workouts_view` exposes a friendlier subset. |
| `workouts_raw` | 864 | Raw imported workout records (source, file path, timestamps) prior to summarization. |
| `workout_samples` | ~2.16M | Second-by-second samples (heartrate, cadence, watts, velocity) per workout. |
| `oura_sleep_raw` | 359 | Nightly sleep detail from Oura (stages, HRV, efficiency, timing). |
| `oura_readiness_raw` | 281 | Oura daily readiness score + contributors. |
| `oura_activity_raw` | 282 | Oura daily activity (steps, calories, activity minutes). |
| `oura_hr_samples` | ~27.6k | High-resolution overnight HR/HRV samples. |
| `nutrition_daily` | 47 | Daily nutrition totals + goals (Cronometer-sourced), meals as JSON. |
| `body_measurements` | — | One row per Renpho smart-scale weigh-in (Apple Health via Health Auto Export): weight, body fat %, lean mass, BMI. `muscle_mass_kg` / `water_pct` stay NULL (not in HealthKit). |
| `daily_physical_state` | 165 | Subjective daily state notes (energy, body signals), sourced from Notion. |
| `planned_workouts` | 6 | Upcoming planned training sessions. |
| `ftp_history` | 5 | FTP (watts) over time, used for power-zone calculations. |
| `strava_sync_log` | 3,634 | Operational log of Strava sync runs (status, counts, errors) — not health data. |
| `analysis_daily_rollup_10d` | — | Rollup view: daily training + sleep + readiness joined for the trailing window. |
| `body_weight_daily` | — | View: first weigh-in of each local day from `body_measurements` (weight, body fat, lean mass, BMI, `n_weighins`). Feeds `nutrition.weight_kg` in the daily export. |

All tables/views live in the `public` schema. `claude_readonly` has `SELECT`
on all of them (including future tables, via `ALTER DEFAULT PRIVILEGES`) and
nothing else.

## Files and paths created

| Path | Purpose |
|---|---|
| `/home/mike/projects/health-data-hub/health-mcp/` | This project: `server.mjs`, `oauth.mjs`, `package.json`, `node_modules/` |
| `/home/mike/.config/health-mcp/health-mcp.env` | Secrets (DB password, API key), mode `600`, owned by `mike`. Not in git (`.gitignore`). |
| `/home/mike/.config/health-mcp/oauth-state.json` | Persisted OAuth state (registered clients, active access/refresh tokens), mode `600`. No client secrets in here — clients are public (PKCE, `token_endpoint_auth_method: none`). |
| `/etc/systemd/system/health-mcp.service` | systemd unit for the MCP server (runs as `mike`, binds `127.0.0.1:8877`, `ReadWritePaths=/home/mike/.config/health-mcp` for the OAuth state file) |
| `/etc/cloudflared/config.yml` | Added ingress rule for `health-mcp.michaelfigari.com` → `http://localhost:8877` (existing file, one rule added; backup left alongside as `config.yml.bak-<timestamp>`) |
| Postgres role `claude_readonly` | SELECT-only on `health_pi`, no other database access |

No existing files were modified except `/etc/cloudflared/config.yml` (one
ingress line added) and this repo's `.gitignore` (entries added for
`health-mcp/node_modules/` and `health-mcp/.env`).

### Why the env file is user-readable, not root-readable

The task's default called for a root-readable secrets file. This Pi's existing
services (`health-data-hub.service`) instead run as the unprivileged `mike`
user with a `mike`-owned, mode-600 `EnvironmentFile`. `health-mcp.service`
follows that same established pattern rather than running as root — running a
network-facing Node process as root would be a larger blast radius than the
default it was meant to avoid. The file is still `chmod 600`, unreadable by
any other non-root account.

## Service management

```bash
# Status
systemctl status health-mcp.service
systemctl status cloudflared.service

# Logs (follow)
journalctl -u health-mcp -f
journalctl -u cloudflared -f

# Restart
sudo systemctl restart health-mcp.service
sudo systemctl restart cloudflared.service
```

Both units are `enabled` (start on boot) and `Restart=on-failure`.

## Rotating secrets

**API key** (`MCP_API_KEY`, used as the Bearer token *and* as the `/authorize`
login password for the OAuth flow):
```bash
NEW_KEY=$(openssl rand -hex 24)
sudo sed -i "s/^MCP_API_KEY=.*/MCP_API_KEY=$NEW_KEY/" /home/mike/.config/health-mcp/health-mcp.env
sudo systemctl restart health-mcp.service
echo "$NEW_KEY"   # update Claude Code / curl usage with this value
```
Rotating it does **not** revoke OAuth tokens claude.ai already holds (those
are independent, in `oauth-state.json`, and expire in 1hr / are refreshed
silently) — it only changes the password needed for a *new* `/authorize`
approval and the static-key path. To force claude.ai to fully re-authenticate,
also clear the state file: `echo '{"clients":{},"tokens":{},"refreshTokens":{}}' | sudo -u mike tee /home/mike/.config/health-mcp/oauth-state.json && sudo systemctl restart health-mcp.service`.

**Postgres password** for `claude_readonly`:
```bash
NEW_PW=$(openssl rand -base64 24 | tr -d '=+/' | head -c 32)
sudo -u postgres psql -c "ALTER ROLE claude_readonly PASSWORD '$NEW_PW';"
sudo sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=$NEW_PW/" /home/mike/.config/health-mcp/health-mcp.env
sudo systemctl restart health-mcp.service
```

## Tearing it down

```bash
# Stop and disable the MCP service
sudo systemctl disable --now health-mcp.service
sudo rm /etc/systemd/system/health-mcp.service
sudo systemctl daemon-reload

# Remove the tunnel ingress rule (edit out the health-mcp block) and DNS record
sudo nano /etc/cloudflared/config.yml   # remove the health-mcp.michaelfigari.com block
sudo systemctl restart cloudflared.service
cloudflared tunnel route dns --overwrite-dns health-webhook <something-else-or-remove-via-dashboard>
# (cloudflared has no "route dns delete" — remove the CNAME from the Cloudflare
# dashboard DNS tab for michaelfigari.com if you want it fully gone)

# Drop the Postgres role
sudo -u postgres psql -d health_pi -c "
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM claude_readonly;
  REVOKE ALL ON SCHEMA public FROM claude_readonly;
  REVOKE ALL ON DATABASE health_pi FROM claude_readonly;
  DROP ROLE claude_readonly;
"

# Remove secrets and code
rm -rf /home/mike/.config/health-mcp
rm -rf /home/mike/projects/health-data-hub/health-mcp
```

The existing `webhook.michaelfigari.com` and `jellyfin.michaelfigari.com`
ingress rules, and the tunnel itself, are untouched by any of the above.

## OAuth 2.1 support (for claude.ai web/mobile)

Claude Code and curl can use a static `Authorization: Bearer <MCP_API_KEY>`
header directly. **claude.ai's web/mobile custom-connector flow cannot** —
per Anthropic's docs, request-header auth for custom connectors is a beta
feature ("slowly rolled out ... contact Anthropic for early access"); absent
that, claude.ai always attempts OAuth 2.1 with Dynamic Client Registration
against the server. Without OAuth endpoints, that registration attempt is
what produced the "Couldn't register with ...'s sign-in service" error.

`oauth.mjs` adds a minimal OAuth 2.1 authorization server, co-located with
the resource server, sized for a single user (there's only one identity —
you — and it maps 1:1 to the same `claude_readonly` Postgres role the static
key already uses). It implements exactly what the MCP authorization spec
(based on OAuth 2.1 draft + RFC 9728 + RFC 8414 + RFC 7591) requires:

| Endpoint | Spec | Purpose |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | Tells the client which authorization server to use |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Advertises `/authorize`, `/token`, `/register`, PKCE support |
| `POST /register` | RFC 7591 | Dynamic Client Registration. Public (unauthenticated) endpoint per spec — protected instead by the redirect-URI allowlist (rejects anything not in `ALLOWED_REDIRECT_URIS`, default `https://claude.ai/api/mcp/auth_callback`) |
| `GET /authorize` | OAuth 2.1 | Renders a one-field HTML page: enter the same access key used as `MCP_API_KEY` to approve. Requires PKCE (`S256`) |
| `POST /authorize/approve` | — | Validates the key, issues a single-use authorization code, redirects to the client's registered `redirect_uri` |
| `POST /token` | OAuth 2.1 | Exchanges code + PKCE verifier for an access token (1hr) + refresh token; also handles `grant_type=refresh_token` |

`GET /mcp` requests are authenticated by `mcpAuth` in `server.mjs`, which
accepts **either** a valid OAuth access token **or** the static
`MCP_API_KEY` — the static-key path for Claude Code/curl is unchanged and
was re-verified working after this change. A `401` on `/mcp` includes
`WWW-Authenticate: Bearer resource_metadata="https://health-mcp.michaelfigari.com/.well-known/oauth-protected-resource"`
as RFC 9728 §5.1 requires, so a client discovering the server cold can find
the authorization server from that header alone.

State (registered clients, active tokens) persists to
`oauth-state.json` so a `systemctl restart health-mcp` doesn't force
claude.ai to re-authenticate — verified: DCR + a refresh-token exchange both
still work immediately after a service restart.

### Verified end-to-end (simulating claude.ai's exact flow, from outside the box)

Each step below was run over the public HTTPS URL with a `python-httpx`
User-Agent (the same client library Anthropic's backend uses to probe MCP
servers), to rule out the tunnel or Cloudflare edge silently blocking
non-browser clients or JSON POSTs on the OAuth paths:

| Step | Result |
|---|---|
| Unauthenticated `POST /mcp` → `401` + `WWW-Authenticate` header | PASS |
| `GET /.well-known/oauth-protected-resource` | PASS |
| `GET /.well-known/oauth-authorization-server` | PASS |
| `POST /register` (DCR) with the Claude redirect URI | PASS — issued `client_id` |
| `POST /register` with a non-allowlisted redirect URI | PASS (correctly rejected, `400`) |
| `GET /authorize` with PKCE `S256` challenge | PASS — rendered login page |
| `POST /authorize/approve` with correct key → redirect with `code`+`state` | PASS |
| `POST /authorize/approve` with wrong key | PASS (correctly rejected, `401`) |
| `POST /token` (`authorization_code` + PKCE verifier) → access + refresh token | PASS |
| Reusing the same authorization code a second time | PASS (correctly rejected, `400` — single-use enforced) |
| `POST /mcp` `initialize` using the OAuth access token | PASS |
| `POST /mcp` `tools/call` (`query`, real SQL) using the OAuth access token | PASS — returned live `workout_summary` row |
| `POST /token` (`refresh_token` grant) after a `systemctl restart health-mcp` | PASS |
| Static `MCP_API_KEY` path on `/mcp` (unaffected by the above) | PASS |

No point in the chain silently dropped the request — the tunnel and
Cloudflare edge pass through non-browser UAs and JSON/form POSTs on these
paths without issue.

### Adding the connector on claude.ai

Just the URL — dynamic registration handles the rest:

```
Remote MCP URL: https://health-mcp.michaelfigari.com/mcp
```

When you click "Connect," claude.ai will open a browser tab to `/authorize`
asking for your access key (the same value as `MCP_API_KEY` in
`health-mcp.env`) — enter it once to approve. If you rotate `MCP_API_KEY`
(see below), that's also the new password for this login page.

## MCP tools exposed

- `list_tables` — lists tables/views in `public` with approximate row counts.
- `describe_table` — columns, types, nullability for a given table/view.
- `query` — runs one `SELECT`/`WITH ... SELECT` statement (rejects writes,
  DDL, and multi-statement input at the app layer as defense-in-depth; the
  Postgres role itself is read-only regardless). Results capped at 1000 rows.

## Defense in depth

1. `claude_readonly` Postgres role: `SELECT`-only grants, no write/DDL
   privileges, `default_transaction_read_only = on`, no `CONNECT` on any
   database other than `health_pi`, 5-connection cap.
2. App-layer SQL guard: single-statement, `SELECT`/`WITH`-only, keyword
   denylist, row cap.
3. Bearer token required on every request (401 otherwise).
4. `Host` header must match `health-mcp.michaelfigari.com` (or localhost) —
   blocks DNS-rebinding-style requests that reach the process directly.
5. MCP server binds `127.0.0.1` only — unreachable except via the tunnel.
6. No inbound firewall/router port opened; cloudflared makes an outbound-only
   connection to Cloudflare's edge.
7. OAuth: PKCE (`S256`) required on every `/authorize` request; authorization
   codes are single-use and expire in 60s; the DCR endpoint only accepts
   registrations whose `redirect_uris` match `ALLOWED_REDIRECT_URIS`; access
   tokens are validated against the exact `resource` (canonical MCP URI) they
   were issued for; the `/authorize` approval step is gated by the same
   secret as the static API key — there is no separate, weaker credential.
