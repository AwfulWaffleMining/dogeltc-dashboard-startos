/* Ids and ports of BOTH nodes come from their own packages, never a local
 * copy. A rename there fails this build instead of the runtime — the same
 * contract quai-dashboard-startos has with go-quai-startos.
 *
 * Namespaced because the two node packages deliberately export the SAME
 * symbol names (`rpcPort`, `healthCheckIds`, `rpcCookieFile`, …). That
 * symmetry is the point: they are the same shape of thing. It just means
 * they cannot both be imported flat. */
import * as ltc from 'litecoin-startos/startos/utils'
import * as doge from 'dogecoin-startos/startos/utils'

export const uiPort = 8080

/* The stratum port miners connect to.
 *
 * 3310 and NOT 3333: on a StartOS box running the neighbouring mining
 * packages, 3301–3306 is go-quai and 3333–3336 is Public Pool. The reference
 * server defaults to 3333 for local testing, which collides with Public Pool
 * on exactly the machines most likely to install this. */
export const stratumPort = 3310
export const stratumInterfaceId = 'stratum'

/* The stratum's own stats API, which the dashboard polls. Loopback inside the
 * container only — it is never bound outward and has no interface, because it
 * is an implementation detail between two processes in one image rather than
 * something a user connects to. */
export const stratumApiPort = 3311

export const mountpoint = '/data'

/** Litecoin: the PARENT chain in AuxPoW. Work is built against this node. */
export const litecoin = {
  packageId: 'litecoin',
  /* The first release of litecoin-startos. A dependent cannot usefully run
   * against anything older because nothing older exists. */
  minVersion: '0.21.5.8:0',
  rpcHostId: ltc.rpcHostId,
  rpcPort: ltc.rpcPort,
  rpcCookieFile: ltc.rpcCookieFile,
  healthCheckIds: ltc.healthCheckIds,
  dataSubdir: ltc.dataSubdir,
} as const

/** Dogecoin: the AUX chain. Its block hash is committed into Litecoin's
 * coinbase, and a winning header is submitted back with `submitauxblock`. */
export const dogecoin = {
  packageId: 'dogecoin',
  /* :5 is the first revision whose sync health check is correct. Earlier
   * revisions could report "Fetching the header chain" forever once the node
   * reached the tip, which would leave this package's dependency on that
   * check permanently unsatisfied — the dashboard would refuse to start
   * against a node that was in fact fully synced. */
  minVersion: '1.14.9:5',
  rpcHostId: doge.rpcHostId,
  rpcPort: doge.rpcPort,
  rpcCookieFile: doge.rpcCookieFile,
  healthCheckIds: doge.healthCheckIds,
  dataSubdir: doge.dataSubdir,
} as const

/** Health check ids this package publishes. */
export const healthCheckIds = {
  stratum: 'stratum',
  dashboard: 'dashboard',
} as const

export const imageId = 'dogeltc-dashboard'
