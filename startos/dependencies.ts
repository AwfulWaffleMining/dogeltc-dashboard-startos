import { sdk } from './sdk'
import { dogecoin, litecoin } from './utils'

/**
 * Both nodes must be installed, running, AND synced.
 *
 * `healthChecks` lists the checks that must be passing, not merely present —
 * naming each node's `sync` check is what makes "fully synced" a dependency
 * rather than a hope. Those ids are a published API of the node packages for
 * exactly this reason; renaming one there breaks this build rather than
 * failing silently at runtime.
 *
 * Why BOTH are required rather than one-or-the-other:
 *
 * AuxPoW is not symmetric. Litecoin is the PARENT chain — the stratum builds
 * a Litecoin block whose coinbase commits to a Dogecoin block hash, and the
 * single scrypt hash of that Litecoin header is tested against both targets.
 * Without the Litecoin node there is no block to build at all. Without the
 * Dogecoin node there is a parent block but no aux commitment, which is
 * ordinary Litecoin solo mining rather than the thing this package is for.
 *
 * Requiring both keeps the promise on the tin honest: install this and you
 * merge mine. If a degraded single-chain mode is ever wanted, StartOS
 * supports optional dependencies and the stratum already treats the aux chain
 * as a separate RPC — but that is a deliberate product decision, not a
 * fallback to slide into when a node is down.
 */
export const setDependencies = sdk.setupDependencies(async ({ effects }) => ({
  [litecoin.packageId]: {
    kind: 'running' as const,
    versionRange: `>=${litecoin.minVersion}`,
    healthChecks: [litecoin.healthCheckIds.node, litecoin.healthCheckIds.sync],
  },
  [dogecoin.packageId]: {
    kind: 'running' as const,
    versionRange: `>=${dogecoin.minVersion}`,
    healthChecks: [dogecoin.healthCheckIds.node, dogecoin.healthCheckIds.sync],
  },
}))
