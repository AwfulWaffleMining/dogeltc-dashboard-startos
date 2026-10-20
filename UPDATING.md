# Updating

## What this package tracks

Three moving parts, each with its own trigger:

1. **The node packages' published ids.** `startos/utils.ts` imports host ids, ports, cookie filenames and health-check ids from `litecoin-startos` and `dogecoin-startos` over npm git dependencies. A rename there fails THIS build rather than the runtime, which is the point.
2. **Each chain's RPC surface.** The stratum calls `getblocktemplate` and `submitblock` on Litecoin, and `createauxblock` / `submitauxblock` on Dogecoin. The dashboard calls `getblockchaininfo`, `getnetworkhashps`, `getblockhash` and `getblock` on both.
3. **The stratum's own stats API**, which the dashboard polls. Both live in this repo, so they move together — but the shapes in `dashboard/main.go` must match what `stratum/scrypt-solo.mjs` emits.

## When a node package changes

Land the node change first, then refresh this lockfile. `npm ci` installs whatever commit the lock names, and `npm update` does NOT move a git dependency.

Raise `minVersion` in `startos/utils.ts` when a change is required rather than merely available. The existing `dogecoin >= 1.14.9:5` floor is a worked example: earlier revisions could report "Fetching the header chain" forever once the node reached the tip, which would leave this package's dependency on that health check permanently unsatisfied against a node that was in fact fully synced.

## When a chain releases a new version

Read the release notes for anything this depends on:

- **`getblocktemplate` rules.** Litecoin already requires `["mweb","segwit"]` and refuses without them; a new soft fork can add to that list. Driven by `GBT_RULES`.
- **`default_witness_commitment`.** Litecoin supplies it and the coinbase must carry it; Dogecoin supplies none and must not. If Dogecoin ever activates segwit, that branch needs revisiting.
- **The AuxPoW RPCs** and the serialization `CAuxPow` expects. The format is read from Dogecoin's source, not from memory — `src/auxpow.h` and `src/auxpow.cpp`.
- **Address formats.** New address types mean new script derivations. The P2SH version-byte set is the dangerous one: an unlisted version produces an output nobody can spend, and nothing rejects it.
- **`initialblockdownload`** in `getblockchaininfo`. The dashboard treats a missing field as "still syncing".

Then run the full loop on regtest for BOTH chains before trusting any of it.

## When the stratum's stats API changes

`dashboard/main.go` decodes it into typed structs, so a renamed field becomes a zero value rather than an error — the page quietly shows nothing instead of failing loudly. Change both sides in the same commit, and check the five endpoints the page needs still return 200:

```
/dash/summary  /dash/workers  /dash/blocks  /dash/history  /dash/shares
```

A missing endpoint does not error visibly: the page catches the failure and falls back to DEMO data, showing plausible numbers that are not the operator's.

## Bumping the package version

Increment the `:N` suffix in `startos/versions/current.ts`. StartOS compares versions to decide whether a sideload is an update, so reinstalling the same string is refused.

The `main` volume persists across package revisions, so recorded blocks and hashrate history survive an update.
