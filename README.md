<p align="center">
  <img src="icon.svg" alt="Quai Mining Dashboard Logo" width="21%" />
</p>

# Quai Mining Dashboard on StartOS

> This package has no separate upstream project: the dashboard server and page
> live in this repository's `dashboard/` directory. Everything it reports about
> mining comes from the Quai Network package on the same server, whose behavior
> is upstream go-quai — see the Documentation section of `instructions.md`.

A mining dashboard for the Quai Network package: hashrate with history, your
workers, the workshares you have minted and what each one paid, how close your
shares are coming, and a builder that fills in the stratum settings for your
hardware.

go-quai keeps its mining statistics in memory only — workers vanish on restart,
hashrate is a ten-minute window, share history is capped — so this package
polls the node and records them on its own volume.

---

## Table of Contents

- [Image and Container Runtime](#image-and-container-runtime)
- [Volume and Data Layout](#volume-and-data-layout)
- [File Models](#file-models)
- [Dependencies](#dependencies)
- [Network Access and Interfaces](#network-access-and-interfaces)
- [Installation and First-Run Flow](#installation-and-first-run-flow)
- [Actions](#actions)
- [Tasks](#tasks)
- [Health Checks](#health-checks)
- [Backups and Restore](#backups-and-restore)
- [Limitations and Differences](#limitations-and-differences)
- [Quick Reference for AI Consumers](#quick-reference-for-ai-consumers)

---

## Image and Container Runtime

The image is built by this repository's `Dockerfile`: a Go server using the
standard library only, on Alpine.

| What          | Detail                                     |
| ------------- | ------------------------------------------ |
| Image source  | Custom Dockerfile, built from `dashboard/` |
| Architectures | x86_64                                     |
| Entrypoint    | `/usr/local/bin/quai-dashboard`            |

One subcontainer, `dashboard`. The page is a single HTML file with bundled
fonts and hand-drawn SVG charts; it makes no requests outside the server, apart
from links to explorer.qu.ai the user can click.

## Volume and Data Layout

One volume, `main`, mounted at `/data`.

| Path                       | Contents                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| `dashboard/stats.json`     | Hashrate history, worker records, share history, every submission and its payout |
| `dashboard/stats.json.bak` | The previous good copy, loaded if the main file is unreadable                    |
| `dashboard/store.json`     | Whether the confirmed-rewards question has been answered                         |

`stats.json` is written by one writer at a time through a temporary file that
is flushed before it replaces the old copy.

| Kept                                                        | Retention                                  |
| ----------------------------------------------------------- | ------------------------------------------ |
| Hashrate and reject rate per algorithm, one sample a minute | 7 days                                     |
| Per-worker averages, last share, online status              | Until 24 hours after a worker's last share |
| Shares with difficulty and block threshold                  | 6000 per algorithm                         |
| Submissions (workshares and blocks) with their payouts      | Permanent                                  |

## File Models

The package owns `dashboard/store.json`, seeded at install with
`rpcSharing: unset` and written only by the Confirmed rewards action (`enabled`
or `declined`). It decides whether the task is raised, nothing else: the
dashboard uses the node's RPC whenever it is reachable, whatever the answer.

`stats.json` belongs to the dashboard server and has no model. The server's
settings arrive as environment variables set on every start: `DASH_STRATUM`
(the node's stats API), `DASH_RPC` (the node's zone RPC, empty while sharing is
off), `DASH_STRATUM_PORTS` (the external stratum ports StartOS assigned to the
node), `DASH_ADDR`, `DASH_ASSETS`, `DASH_DATA`. The package restarts the
dashboard whenever the node's addresses change, including when RPC sharing is
switched on or off.

## Dependencies

**Quai Network** — required, running, with its **Node** and **Chain Sync**
checks passing before this service starts. No volumes are mounted. The
dashboard reads the node's Mining Stats API, and its zone RPC when RPC sharing
is on. A fresh node syncing from genesis therefore keeps the dashboard stopped
for weeks.

## Network Access and Interfaces

One interface.

| Interface id | Type | Port | Protocol | Purpose       |
| ------------ | ---- | ---- | -------- | ------------- |
| `ui`         | ui   | 8080 | HTTP     | The dashboard |

The same port serves the read-only JSON the page uses: `dash/summary`,
`dash/workers`, `dash/blocks`, `dash/history?range=1h|24h|7d`,
`dash/shares?range=`, `dash/export.csv?range=&algo=`, and `/health`. None of it
is authenticated.

## Installation and First-Run Flow

Nothing needs configuring. The dashboard finds the node over the local bridge,
raises the Confirmed rewards task, and starts once the node is synced. History
accumulates from the first start.

## Actions

**Confirmed rewards** — whether the dashboard may use the node's RPC to classify
each submission and report what it actually paid. Instant and safe to repeat.

Answering yes stores the answer and raises a task on the Quai Network package's
Settings action with RPC sharing pre-filled; nothing on the node changes until
the user saves that form. Answering no stores the answer. Neither changes what
the dashboard displays: turning RPC sharing off later is done on the node, not
here.

## Tasks

| Task                       | Where it appears    | Severity  | Raised when                        | Cleared by                                         |
| -------------------------- | ------------------- | --------- | ---------------------------------- | -------------------------------------------------- |
| Confirmed rewards          | This service        | important | The question has not been answered | Running Confirmed rewards either way               |
| Settings (on Quai Network) | Quai Network's page | important | Confirmed rewards answered yes     | Saving Quai Network's Settings with RPC sharing on |

Neither blocks startup.

## Health Checks

| Check id    | Display   | Probes                                      |
| ----------- | --------- | ------------------------------------------- |
| `dashboard` | Dashboard | Port 8080 listening; 10-second grace period |

The check stays green while the node is unreachable: the dashboard keeps
serving the recorded history and the page says the node cannot be reached. The
log records the first failed poll and the recovery. If Quai Network is not
running or not synced when the dashboard starts, the start fails with a
message naming the node's failing check.

## Backups and Restore

The whole volume is backed up with `ofVolumes`. It is small, and it is the only
record of what was mined: the node does not keep it. A restore brings back the
history and the confirmed-rewards answer; nothing needs rebuilding.

## Limitations and Differences

1. **Payouts are found by scanning.** A workshare is paid by a transaction a few
   blocks later; until the dashboard finds it, the card shows an estimate and
   says so. A workshare with no payout after three complete scans is marked
   orphaned — accepted by stratum, never included in a block, paid nothing.
2. **Classification and paid amounts need the node's RPC.** Without it,
   submissions stay unverified and rewards are estimates.
3. **Confirmation is not unlocking.** A reward confirms quickly and then stays
   locked for the lock period the miner chose.
4. **SHA-256 and Scrypt mint workshares, not blocks.** Only KawPoW proofs mint
   blocks on Quai.
5. **No price data.** Everything is in QUAI; fetching a price would mean outside
   requests.
6. **x86_64 only**, matching the node package.

---

## Quick Reference for AI Consumers

```yaml
package_id: quai-dashboard
image: dashboard (built from Dockerfile)
architectures: [x86_64]
subcontainers: [dashboard]
volumes:
  main: /data
file_models:
  - dashboard/store.json
startos_managed_env_vars:
  - DASH_ADDR
  - DASH_ASSETS
  - DASH_DATA
  - DASH_STRATUM
  - DASH_STRATUM_PORTS
  - DASH_RPC
dependencies:
  - go-quai
interfaces:
  ui: { type: ui, port: 8080 }
actions:
  - confirmed-rewards
tasks:
  - { action: confirmed-rewards, severity: important }
  - { action: go-quai/config, severity: important }
health_checks:
  - dashboard
```
