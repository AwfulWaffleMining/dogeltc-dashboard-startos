import { storeJson } from './fileModels/store.json'
import { i18n } from './i18n'
import { sdk } from './sdk'
import {
  dogecoin,
  healthCheckIds,
  imageId,
  litecoin,
  mountpoint,
  stratumApiPort,
  stratumPort,
  uiPort,
} from './utils'

/* Where each node's volume is mounted, read-only, so the stratum can read the
 * cookie file that node writes for local RPC auth.
 *
 * This is why no credential is configured anywhere in this package. Cookie
 * auth is exactly right for a caller that can read the volume: `.cookie` is
 * rewritten on every node start, and a caller that reads it per call always
 * holds the current one. The alternative — issuing this package an `rpcauth`
 * user on each node — would mean a credential to store, rotate and leak. Both
 * node packages publish `rpcCookieFile` as API for this. */
const depMounts = {
  litecoin: '/deps/litecoin',
  dogecoin: '/deps/dogecoin',
} as const

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting scrypt solo mining'))

  /* Both nodes running AND synced. The dependency declares the sync health
   * checks, so this throws rather than starting a stratum that would build
   * work against a chain it has not finished validating — which is how a
   * miner ends up hashing on a fork. */
  const depResult = await sdk.checkDependencies(effects)
  depResult.throwIfNotSatisfied()

  const rpcAddress = async (
    chain: typeof litecoin | typeof dogecoin,
    label: string,
  ) => {
    const addr = await sdk.host
      .getBridgeAddress(effects, {
        packageId: chain.packageId,
        hostId: chain.rpcHostId,
        internalPort: chain.rpcPort,
        ssl: false,
      })
      .const()
      .catch(() => null)
    if (!addr) {
      throw new Error(
        i18n('Cannot reach the ${chain} node over RPC', { chain: label }),
      )
    }
    return addr
  }

  const ltcRpc = await rpcAddress(litecoin, 'Litecoin')
  const dogeRpc = await rpcAddress(dogecoin, 'Dogecoin')

  const store = await storeJson.read().const(effects)
  const payoutMode = store?.payoutMode ?? 'unset'

  const sub = await sdk.SubContainer.of(
    effects,
    { imageId },
    sdk.Mounts.of()
      .mountVolume({
        volumeId: 'main',
        subpath: null,
        mountpoint,
        readonly: false,
      })
      /* Read-only: this package has no business writing into a node's
       * datadir, and a mistake that did would be a corrupted chainstate on a
       * service the operator did not ask us to touch. */
      .mountDependency({
        dependencyId: litecoin.packageId,
        volumeId: 'main',
        subpath: null,
        mountpoint: depMounts.litecoin,
        readonly: true,
      })
      .mountDependency({
        dependencyId: dogecoin.packageId,
        volumeId: 'main',
        subpath: null,
        mountpoint: depMounts.dogecoin,
        readonly: true,
      }),
    imageId,
  )

  const [ltcHost, ltcPort] = ltcRpc.split(':')
  const [dogeHost, dogePort] = dogeRpc.split(':')

  return sdk.Daemons.of(effects)
    .addDaemon(healthCheckIds.stratum, {
      subcontainer: sub,
      exec: {
        command: ['node', '/opt/stratum/scrypt-solo.mjs'],
        env: {
          /* Litecoin is the PARENT chain: work is built against it. */
          RPC_HOST: ltcHost,
          RPC_PORT: ltcPort,
          RPC_COOKIE: `${depMounts.litecoin}/${litecoin.dataSubdir}/${litecoin.rpcCookieFile}`,
          /* Dogecoin is the AUX chain, committed into the parent's coinbase. */
          AUX_RPC_HOST: dogeHost,
          AUX_RPC_PORT: dogePort,
          AUX_RPC_COOKIE: `${depMounts.dogecoin}/${dogecoin.dataSubdir}/${dogecoin.rpcCookieFile}`,

          STRATUM_PORT: String(stratumPort),
          STRATUM_API_PORT: String(stratumApiPort),

          /* Scrypt difficulty-1 is 2^16 hashes, NOT Bitcoin's 2^32. Getting
           * this wrong makes every honest share 65,536x too hard to find and
           * rejects all of them. */
          SCRYPT_DIFF_SHIFT: '16',

          /* 'unset' is a real state the stratum must handle, not a missing
           * value: it listens so the dashboard can explain itself, and
           * refuses to hand out work. See startos/fileModels/store.json.ts
           * for why a blank address is not good enough. */
          PAYOUT_MODE: payoutMode,
          PAYOUT_ADDRESS: store?.ltcAddress ?? '',
          AUX_PAYOUT_ADDRESS: store?.dogeAddress ?? '',

          VARDIFF_TARGET: String(store?.vardiffTargetSeconds ?? 15),
          REPORT_SECONDS: String(store?.reportSeconds ?? 60),
        },
      },
      ready: {
        display: i18n('Stratum'),
        gracePeriod: 15_000,
        fn: async () => {
          /* Only 'unset' holds the port closed. 'workerName' is a real
           * choice -- store nothing, let each miner say where to pay -- so
           * the stratum binds and this must report on the port like any
           * other running mode. */
          if (payoutMode === 'unset') {
            return {
              result: 'starting' as const,
              message: i18n('Set a payout destination before mining starts'),
            }
          }
          return sdk.healthCheck.checkPortListening(effects, stratumPort, {
            successMessage: i18n('Accepting miners'),
            errorMessage: i18n('The stratum is starting'),
          })
        },
      },
      requires: [],
    })
    .addDaemon(healthCheckIds.dashboard, {
      subcontainer: sub,
      exec: {
        command: ['/usr/local/bin/scrypt-dashboard'],
        env: {
          DASH_ADDR: `:${uiPort}`,
          DASH_ASSETS: '/opt/dashboard',
          DASH_DATA: `${mountpoint}/dashboard`,
          /* Loopback: the stratum's stats API is an implementation detail
           * between two processes in one image, never bound outward. */
          DASH_STRATUM: `http://127.0.0.1:${stratumApiPort}`,
          DASH_LTC_RPC: `http://${ltcRpc}`,
          DASH_DOGE_RPC: `http://${dogeRpc}`,
          DASH_LTC_COOKIE: `${depMounts.litecoin}/${litecoin.dataSubdir}/${litecoin.rpcCookieFile}`,
          DASH_DOGE_COOKIE: `${depMounts.dogecoin}/${dogecoin.dataSubdir}/${dogecoin.rpcCookieFile}`,
          DASH_STRATUM_PORT: String(stratumPort),
          DASH_PAYOUT_MODE: payoutMode,
        },
      },
      ready: {
        display: i18n('Dashboard'),
        gracePeriod: 10_000,
        fn: () =>
          sdk.healthCheck.checkPortListening(effects, uiPort, {
            successMessage: i18n('The dashboard is ready'),
            errorMessage: i18n('The dashboard is starting'),
          }),
      },
      /* The dashboard reads the stratum's stats API, so it comes up second.
       * It does NOT fail when the stratum is unconfigured: that is precisely
       * the state where a user needs the page to tell them what to do. */
      requires: [healthCheckIds.stratum],
    })
})
