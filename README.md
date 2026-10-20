# scrypt-solo-startos

A StartOS service package that solo **merge-mines Dogecoin and Litecoin** against the operator's own nodes.

This file is the technical reference for an agent or administrator working on the package. End-user documentation lives in `instructions.md`; conventions and hard-won constraints live in `AGENTS.md`; outstanding work is tracked in this repository's GitHub issues.

## What it is

Three packages, one job:

| package | role |
| --- | --- |
| `litecoin-startos` | the **parent** chain node |
| `dogecoin-startos` | the **aux** chain node |
| this one | the stratum miners connect to, plus the dashboard |

Both nodes are required dependencies and both must be **fully synced** before this starts.

## How merge mining actually works here

The stratum asks Litecoin for a block template and Dogecoin for an aux block (`createauxblock`). It commits the Dogecoin block's hash into the Litecoin coinbase, then hands the miner a header to grind. **One scrypt hash is tested against two unrelated targets.**

- clears Litecoin's target → `submitblock` to Litecoin
- clears Dogecoin's target → `submitauxblock` to Dogecoin
- clears both → paid on both, from the same work

Nothing is split and nothing is shared. This is the Namecoin AuxPoW standard, which Dogecoin has accepted since block 371,337.

**The aux chain is checked first and independently.** Dogecoin's target is the easier of the two — a 60-second block against Litecoin's 150 — so most wins are aux-only. Gating the aux submission behind the parent check would discard the majority of what merge mining earns, silently.

## Layout

| path | role |
| --- | --- |
| `stratum/scrypt-solo.mjs` | the stratum server. Zero runtime dependencies |
| `stratum/test/` | checks that need no daemon |
| `dashboard/main.go` | collector and JSON API |
| `dashboard/index.html` | the page. One file, no external requests |
| `startos/utils.ts` | ids and ports, imported FROM the node packages |
| `startos/dependencies.ts` | both nodes, both sync checks |
| `startos/actions/payout.ts` | the payout union |

## Ports

| port | purpose | exposure |
| --- | --- | --- |
| 3310 | stratum | bound for miners |
| 3311 | stratum stats API | **127.0.0.1 only** |
| 8080 | dashboard UI | StartOS interface |

3310 and not 3333: on a StartOS box running the neighbouring mining packages, 3301–3306 is go-quai and 3333–3336 is Public Pool.

One stratum port serves both chains. Merge mining is a single connection; a miner split across two would mine the same work twice.

## Credentials

**Nothing is stored.** Each node's volume mounts read-only and the stratum reads its `.cookie` file, fresh on every call — Core rewrites it on every start, and a node restarting is exactly when this must keep working.

Payout addresses are config, never part of a worker name. That matters twice over: stratum v1 is plaintext, so the pool convention of `LTC_ADDRESS,DOGE_ADDRESS.RIG_ID` puts both addresses on the wire on every connect; and it is ~85 characters with a comma in it, which Canaan/Avalon firmware rejects outright.

Payouts have four states, and `unset` is the shipped one:

- **unset** — the stratum does *not* bind its port. A server that accepts miners and hands out work it cannot pay for is worse than one plainly off.
- **addresses** — pays addresses the operator controls, off this server.
- **nodeWallet** — a genuinely fresh address per block: `JobManager` asks each node for one on every template, so the claim is literal rather than aspirational. Better on-chain privacy; the wallet files then become the only record of what you were paid.
- **workerName** — nothing stored. Each miner authorizes as `LTC_ADDRESS,DOGE_ADDRESS.RIG` and gets its own job built around those addresses. A plain username is refused, because it has nowhere to pay. This binds the port: it is a choice, not an absence.

**Jobs are keyed by payout target.** The coinbase pays the address and sits in the merkle root the miner hashes, so miners with different addresses need different jobs — but all of one person's rigs share a target, so the home case costs what a single-address server costs. Capped at 8 targets: the username is attacker-controlled on any reachable LAN, and each target costs an RPC per template on both chains.

## The data model

**ONE hashrate, ONE share stream, TWO targets.** Per-chain hashrate is a fiction. The collector keeps a history series per chain, but computes the rate and the reject percentage once and writes the same values into every series — so the dashboard shows a single merged chart with no chain selector, because a selector would imply a division that does not happen. Workers are never filtered by chain either: every rig mines both. Only **blocks** belong to a chain.

Shares are reported per chain anyway, because the same share is tested against two different targets: a submission that is 0.3% of Dogecoin's target is a smaller fraction of Litecoin's.

What replaces payout reconciliation is **maturity**: a coinbase is unspendable for 100 confirmations, so "found" and "spendable" are different states. Orphans are counted, not hidden.

The luckiest share ever seen is kept per chain, in the collector's own store rather than the stratum's bounded buffer, and compared on **luck** rather than raw difficulty. The same share is a different fraction of each target, and the two records can be different shares: each is kept against the network difficulty of its own moment.

That figure carries the dashboard. At solo odds `blocksFound` is zero for months, and a page of zeroes says nothing about whether the hardware is working; how close you have come is always a real number and only ever improves.

## Building and testing

```bash
node stratum/scrypt-solo.mjs --meter      # 52 checks, no daemon
node stratum/test/address-scripts.mjs     # 13 checks, no daemon or network
cd dashboard && go vet ./... && go build .
npm run check && npx prettier --check startos
```

The full loop needs regtest nodes for both chains. Dogecoin refuses `getblocktemplate` without peers, unlike Litecoin, so it needs two nodes connected to each other:

```bash
node stratum/scrypt-solo.mjs --selftest   # with AUX_RPC_HOST set: both chains
```

That should advance **both** chains by one block from a single share. The aux payout is resolved from the aux node when `AUX_PAYOUT_ADDRESS` is unset, so this needs no hand-set variables.

To exercise the opt-out path instead — the server storing nothing, the miner supplying both addresses:

```bash
SELFTEST_PAYOUT_WORKER="$LTC_ADDR,$DOGE_ADDR.rig1" node stratum/scrypt-solo.mjs --selftest
```

The server then holds no address at all, so the assertion that the coinbase pays `$LTC_ADDR` can only pass if the username carried it into the block.

## Status

Mining is proven end to end on regtest. A single share advanced Litecoin 102→103 and Dogecoin 102→103, and Dogecoin's own node validated the auxpow — merkle branches and parent PoW — before accepting it.

Verified against the real daemons rather than assumed: Litecoin requires `["mweb","segwit"]` template rules; its coinbase needs a witness commitment and Dogecoin's must not have one; bech32 and all five P2SH version bytes derive the same scripts litecoind's own `getaddressinfo` reports; `initialblockdownload` exists on both.

The dashboard was verified by rendering it in Chromium against the live stack, in both themes, with no page errors.

**Not yet done:** the Docker image has never been built (no daemon in the development environment, so CI is its first build); nothing has run on StartOS hardware; a block has not been observed flowing through the collector's `mergeBlocks` and confirmation refresh; and x86_64 is the only architecture, though both node packages ship aarch64.
