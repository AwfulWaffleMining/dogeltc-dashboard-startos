# AGENTS.md

This is a StartOS service-package repository — it builds a `.s9pk` for StartOS.

Develop it inside a StartOS packaging workspace created by `start-cli s9pk init-workspace`,
which provides the packaging guide and agent context one level up. If you're reading this in a
bare clone with no workspace, the full guide is at <https://docs.start9.com/packaging>.

**Start every task at the recipe index** — `../start-technologies/projects/start-sdk/docs/src/recipes.md`
(or <https://docs.start9.com/packaging/recipes.html>).

Keep `README.md` (technical reference for an AI support or administering agent) and `instructions.md` (end-user docs) in sync with your changes. Don't record work in the repo: no `TODO.md`, no `NOTES.md`. What you verified belongs in the commit message; what's outstanding belongs in a GitHub issue.

## What this is

A stratum server and dashboard that solo merge-mine Dogecoin and Litecoin against the operator's own nodes. Three packages: `litecoin-startos` and `dogecoin-startos` are the nodes, this is the miner. It is modelled on `quai-dashboard-startos`, and rules marked **(inherited)** were paid for there or in the node packages.

## Merge mining decides almost everything

- **Litecoin is the PARENT and Dogecoin the AUX chain, and that is not symmetric.** The stratum builds a *Litecoin* block whose coinbase commits to a Dogecoin block hash; one scrypt hash of the Litecoin header is tested against both targets. Without the Litecoin node there is nothing to build. This is why both nodes are required dependencies and why the Litecoin one gates everything.
- **ONE hashrate, ONE share stream, TWO targets.** Per-chain hashrate is a fiction. The same figure is reported under both chains deliberately. A worker is never filtered by chain either — every rig mines both, and showing one under a single chain would misstate what it does. Blocks DO belong to a chain; workers and shares do not.
- **Check the aux chain FIRST and independently.** The targets are unrelated and Dogecoin's is the easier of the two — a 60-second block against Litecoin's 150 — so most wins are aux-only. Gating the aux submission behind the parent check throws away the majority of what merge mining earns, silently.
- **Never let an aux failure stop work going out.** Losing the aux chain costs the second ticket, not the first; the parent stays mineable. Likewise a failed `submitauxblock` still credits the share: the share cleared the target we set, and firmware counts rejects to decide a pool is broken.
- **The chain merkle branch is empty and the chain index is 0**, because there is exactly one aux chain. `getExpectedIndex` ends in `% (1 << h)` with `h = 0`. Verified against Dogecoin's `CAuxPow::check`.
- **The aux root hash goes into the coinbase UNREVERSED** — as `createauxblock` reports it. Dogecoin reverses the internal uint256 before searching the script ("correct endian", in its own comment). Reversing it here yields a coinbase that looks right and fails with "missing chain merkle root".
- **The auxpow's `tx` is the STRIPPED parent coinbase, never the witness form.** Dogecoin 1.14 predates segwit and has no marker/flag concept: handed the witness serialization it reads `0x00` as an input count of zero and rejects with "coinbase has no inputs".

## Chain differences that have already caused bugs

- **`getblocktemplate` rules are per-chain and NOT optional on Litecoin.** Litecoin 0.21 refuses without `["mweb","segwit"]`; Dogecoin 1.14 wants an empty list. Driven by `GBT_RULES`.
- **Litecoin needs a witness commitment in the coinbase; Dogecoin must not have one.** Take it from the template's `default_witness_commitment` rather than computing it — the node has already committed to the right wtxid merkle root for this transaction set.
- **The witness is spliced in at SUBMISSION only, never given to miners.** `coinb1`/`coinb2` stay the stripped serialization because the miner hashes them to get the coinbase txid for the merkle root, and a txid is defined over non-witness bytes. Hand a miner the witness form and every merkle root it computes is wrong: shares look fine, blocks are rejected.
- **P2SH version bytes are `{5, 22, 50, 58, 196}` and getting this wrong LOSES THE BLOCK.** An unlisted P2SH version falls through to the P2PKH branch, wrapping a script hash in a pay-to-pubkey-hash output nobody holds a key for. The block is valid, the node accepts it, the coins are gone. Litecoin's `M…` (50) and `Q…` (58) were missing originally. Confirm any new chain's bytes against that chain's own `getaddressinfo`.
- **Bech32 is decided by the HRP, never by the shape of the string.** A real P2SH address (`QetEvio3nP3tJ1N3pheTn3gQCd8eR2GkgW`) contains a `1` followed only by bech32-charset characters. Deciding by shape sent it down the bech32 path, where the mixed-case rule rejected it — breaking every legacy and P2SH payout. Both bech32 and bech32m checksum constants are implemented, because BIP350 changed it at witness v1 specifically so a v1 address cannot be validated by a v0-only implementation.
- **Scrypt difficulty 1 is 2^16 hashes, NOT Bitcoin's 2^32. (inherited)** The wrong constant makes every honest share 65,536x too hard and every hashrate figure nonsense.

## Package rules

- **Ids, ports and health-check ids come from the node packages, never a local copy. (inherited)** `startos/utils.ts` imports them, so a rename there fails this build instead of the runtime.
- **Both nodes are required AND must be synced.** `setupDependencies` names each node's `sync` health check. `dogecoin >= 1.14.9:5` is a floor, not decoration: earlier revisions could report "Fetching the header chain" forever at the tip, leaving this dependency permanently unsatisfied against a node that was in fact synced.
- **No credential is stored anywhere.** Each node's volume mounts read-only and the stratum reads its `.cookie`. Cookie files are read FRESH on every call, never cached: Core rewrites `.cookie` on every start, and a node restarting is exactly when this must keep working.
- **Jobs are keyed by PAYOUT TARGET, never by worker.** The coinbase pays the address, the coinbase is in the merkle root, the merkle root is in the header — so two miners with different payout addresses cannot share a job. They can share a *target*: every rig in one household points at the same two wallets, so the usual case is one target and exactly the RPC cost of a single-address server. Each target needs its own `createauxblock`, because that call builds the aux coinbase around the address it is given.
- **There are FOUR payout modes and only `unset` holds the port closed.** `addresses` pays what is stored; `nodeWallet` asks each node for a fresh address on every template; `workerName` stores nothing and requires each miner to authorize as `LTC_ADDRESS,DOGE_ADDRESS.RIG`; `unset` means no choice has been made. `workerName` is a deliberate choice, so it binds and serves — treating it like `unset` would make the opt-out indistinguishable from a half-finished install.
- **`nodeWallet` passes NO address in the environment, and that is correct.** The action clears both on purpose. An earlier revision let `main.ts` hand the stratum `PAYOUT_ADDRESS: ''` with nothing resolving it, and the service died at startup with `bad address length for` — offered in settings, documented in both docs, never once working. The mode is handled in `run()`, not papered over with a fallback address.
- **Parse a supplied payout INSIDE the try that answers the miner.** `parseWorkerPayout` throws on a malformed address. An exception escaping the `mining.authorize` handler is caught by the socket's generic `.catch`, which logs and sends nothing — the miner sits on an unanswered authorize until it gives up, which reads as a dead pool rather than a typo. Refuse with a stratum error instead.
- **A supplied address that does not decode must NEVER fall back to the configured one.** Silently paying the operator for someone else's work, or the reverse, is worse than refusing the connection.
- **Cap the number of distinct targets.** The worker name is attacker-controlled on any LAN the stratum is reachable from, and each new target costs an RPC per template on both chains. `JobManager.MAX_TARGETS` is 8.
- **`payoutMode: 'unset'` is a real state, not a missing value.** In that state the stratum does NOT bind its port. A server that accepts miners and hands out work it cannot pay for is worse than one that is plainly off: the rig shows accepted shares and the truth surfaces only when a block is found. It serves the stats API so the dashboard can say what is missing, and nothing else.
- **The stats API binds 127.0.0.1 only.** It reports worker names and payout state — fine for the dashboard in the same container, not fine on a LAN.
- **Keep the stratum's zero runtime dependencies.** `node:http`, `node:net`, `node:crypto`, `node:fs` are builtins. Nothing else.
- **Join password options with `_`, never `,`. (inherited)** Canaan/Avalon firmware rejects a comma in the password field. This is also why config, not the worker name, is the DEFAULT home for payout addresses: the pool convention of `LTC_ADDRESS,DOGE_ADDRESS.RIG_ID` is ~85 characters with a comma in it, and stratum v1 is plaintext so it puts both addresses on the wire on every reconnect. `workerName` mode exists for operators who would rather pay those costs than store addresses on the server — it is offered with both costs stated, never as the easy path.
- **Keep the page free of external requests. (inherited)** No CDNs, no web fonts, no charting libraries. The bundled fonts are SIL OFL.
- **Never let two saves of `stats.json` run at once. (inherited)** Shutdown triggers a save from both the poll loop and main; a shared temp file truncated the history once. The temp name carries the pid.
- **A failed block lookup is NOT evidence of an orphan. (inherited)** An RPC that times out is not a chain that forgot your block.
- **i18n ids are STABLE and must never be renumbered. (inherited)** `npm run i18n` regenerates `default.ts` from the `i18n()` calls, preserving every existing id and only appending; a key removed from the code keeps its id reserved rather than freeing it for reuse. `npm run i18n:check` fails if the dictionary is stale, if a language is missing an id, or if a translation's `${placeholders}` differ from the English key's. Run it after any i18n change. (Both scripts live in `scripts/`; before they existed, AGENTS.md told agents to "regenerate" with a generator that was not in the repo.)

## Testing

Both daemons run on regtest and that is how everything above was proven. Dogecoin refuses `getblocktemplate` without peers, unlike Litecoin, so it needs two nodes connected to each other.

```bash
node stratum/scrypt-solo.mjs --meter          # 52 pure checks, no daemon
node stratum/test/address-scripts.mjs         # 13 checks, no daemon or network
node stratum/scrypt-solo.mjs --selftest       # full loop against regtest
cd dashboard && go vet ./... && go build .
npm run check && npx prettier --check startos
```

`--selftest` with `AUX_RPC_HOST` set exercises merge mining end to end and should advance BOTH chains by one block from a single share.
