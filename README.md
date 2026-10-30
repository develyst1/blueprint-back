# blueprint-back

The Blueprint API: the AI interview, the spec store (parts, links, change sets, versions), the understanding quiz and the seam that caw-back reads. Bun + TypeScript + Hono, one process, default port **4200**.

## Prerequisites

Linux x64 (tested: Debian 13). Each line has the command that checks it.

| Need | Tested | Check |
|---|---|---|
| bun 1.4.x | 1.4.2 | `bun --version` |
| PostgreSQL (or `pglite:memory` for a throw-away trial: data is lost on restart) | — | `psql --version` |
| pm2 (to run it as a service; without it use `bun run start`) | 7.0.4 | `pm2 --version` (`npm install -g pm2` if missing) |

## Install

```bash
git clone -b atom <repo URL> blueprint-back
cd blueprint-back
bun install --frozen-lockfile
```

## Configuration

Copy the example and fill it in. **Never commit `.env`, and never paste `DATABASE_URL` anywhere** (it can hold a password).

```bash
cp .env.example .env
```

| Variable | What it is | Example | Required / default |
|---|---|---|---|
| `DATABASE_URL` | Postgres connection URL; the database must be named `blueprint`. `pglite:memory` = a throw-away in-memory database | `postgres://user:password@127.0.0.1:5432/blueprint` | **required** |
| `PORT` | Port the API listens on (an integer 1–65535) | `4200` | optional, `4200` |
| `HOST` | Address to listen on. Empty = this machine only; set `0.0.0.0` only on a server you have secured (there is no login) | `127.0.0.1` | optional, `127.0.0.1` |
| `SOURCES_DIR` | Folder for uploaded originals | `/var/lib/blueprint/sources` | optional, `./data/sources` |
| `GATEWAY_URL` | Base URL of the LLM Gateway | `https://ai.develyst.online` | optional, `https://ai.develyst.online` |
| `GATEWAY_LIGHT_MODEL` | Cheap model for light gateway calls (re-asks, corrections, quiz answers): `tier:small` or `<provider>/<model>`. A bad value is logged (never printed) and the project's model is used | `tier:small` | optional, `tier:small` |
| `CAW_NOTIFY_URL` | CAW's notice address (http/https): after each confirmed version and each saved change Blueprint posts a notice there. Empty = no outbound call; CAW reads the API instead | `http://127.0.0.1:4500/v1/notify` | optional, empty |

Tests only (leave unset on a server):

| Variable | What it does |
|---|---|
| `BLUEPRINT_LINK_TEST_ALLOW` | `<host>:<port>[,…]` — lets those local addresses through the private-address refusal; ignored unless `DATABASE_URL=pglite:memory` |
| `BLUEPRINT_GATEWAY_LIVE` | `1` = run the one live LLM Gateway smoke test |
| `BLUEPRINT_SIT` | `1` = run the database rules test against the Postgres in `DATABASE_URL` (rolled back; nothing is committed) |

## Database

Skip this for `pglite:memory`. For Postgres:

```bash
bun run db:create     # only if the database does not exist; it must be named "blueprint"
bun run db:migrate    # prints: migrations applied
```

Run `bun run db:migrate` again after every update that adds a migration. Blueprint refuses to start on a database that is behind (see "Start-up errors").

## Build

None. Bun runs the TypeScript directly.

## Start, stop, restart, logs

With pm2 (the way to run it as a service):

```bash
pm2 start ecosystem.config.cjs     # first time
pm2 restart blueprint-back
pm2 stop blueprint-back
pm2 logs blueprint-back
pm2 save                           # so "pm2 resurrect" brings it back after a reboot
```

`pm2 startup` (start at boot) is a one-off that needs root; it is the server owner's.

Without pm2, in a terminal: `bun run start`.

## Check it is up

After a start or restart, allow a few seconds, then:

```bash
curl -s http://127.0.0.1:4200/health
```

Expected: `{"ok":true,"service":"blueprint-back"}` (use your `PORT`).

## Update

```bash
git pull                          # branch atom
bun install --frozen-lockfile
bun run db:migrate
pm2 restart blueprint-back
```

Then "Check it is up".

## Start-up errors

A problem at start is one line on stderr (`pm2 logs blueprint-back` shows it), then the process exits 1. The line never holds the value of `DATABASE_URL`.

| Line (after `blueprint-back: `) | What to do |
|---|---|
| `missing required setting DATABASE_URL` | Set `DATABASE_URL` in `.env` (or use `pglite:memory` for a trial). |
| `wrong setting DATABASE_URL (not pglite:memory or a postgres:// URL)` | It must be `pglite:memory` or start with `postgres://` or `postgresql://`. |
| `wrong setting PORT ("<value>" is not a port number)` | Set `PORT` to a whole number from 1 to 65535, or leave it empty for 4200. |
| `wrong setting DATABASE_URL (cannot reach the database, code <code>)` | The database did not answer. Check the host, port, user and password, and that Postgres is running (`ECONNREFUSED` = nothing is listening there). |
| `database is not migrated — run bun run db:migrate` | Run `bun run db:migrate`, then start again. |
| `cannot listen on <HOST>:<PORT> (<code>)` | `EADDRINUSE` = another process holds that port: change `PORT` or stop the other one. Another code: check `HOST`. |

Each line ends with ` — see README § Configuration`.

## I-Space on one server

I-Space is four services. Default ports (each one's `PORT` / start setting can change it):

| Service | Port | Talks to | Setting that points at it |
|---|---|---|---|
| blueprint-back (API) | 4200 | its database | blueprint-front `BLUEPRINT_API_URL` · caw-back `BLUEPRINT_URL` |
| blueprint-front (web) | 3100 | blueprint-back; opens caw-front in the user's browser | caw-back `BLUEPRINT_WEB_URL` · caw-front `BLUEPRINT_URL` |
| caw-back (API, MCP, runner) | 4500 | its database, blueprint-back, Claude CLI | caw-front `CAW_API_URL` |
| caw-front (web) | 3500 | caw-back | blueprint-front `CAW_URL` (the user's browser opens it) |

Start order: blueprint-back → blueprint-front → caw-back → caw-front. Only the two web ports (3100, 3500) must be reachable from users' browsers; the APIs can stay on 127.0.0.1.

First time on a new server: install the prerequisites of all four READMEs → clone all four on branch `atom` → fill each `.env` → blueprint-back `bun run db:migrate` → caw-back's database and CAW work folder steps (caw-back README) → Claude CLI installed and logged in to the subscription as the user pm2 runs CAW as (caw-back README) → build both fronts → `pm2 start ecosystem.config.cjs` in each repo, in the order above → each README's "Check it is up" → `pm2 save`.
