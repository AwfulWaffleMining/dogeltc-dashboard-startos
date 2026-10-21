import { i18n } from './i18n'
import { sdk } from './sdk'
import { stratumInterfaceId, stratumPort, uiPort } from './utils'

export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  /* ONE host for both the page and the stratum, deliberately.
   *
   * The dashboard's "How to connect" tab builds the pool URL from
   * location.hostname — the address the operator opened the page on. Put the
   * stratum on a second host and StartOS gives it a different hostname, so
   * that tab would hand out an address nothing is listening on. Sharing the
   * host is what makes the instructions true.
   *
   * The stats API (stratumApiPort) is deliberately NOT here. It reports
   * worker names and payout state, and the dashboard reaches it over
   * loopback inside the container. It has no business on a LAN.
   */
  const host = sdk.MultiHost.of(effects, 'main')

  const uiOrigin = await host.bindPort(uiPort, { protocol: 'http' })
  const ui = sdk.createInterface(effects, {
    name: i18n('Mining Dashboard'),
    id: 'ui',
    description: i18n(
      'Hashrate, workers, blocks found, share luck, and the settings for your miners',
    ),
    type: 'ui',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })

  /* Raw TCP, and the external port pinned to the internal one so the address
   * in the dashboard, in the docs and in a miner's config are all the same
   * number. Without this binding the stratum listens inside the container and
   * StartOS routes nothing to it: the port is simply closed from the LAN, and
   * a miner pointed at it reports the pool dead with nothing in any log to
   * say why. */
  const stratumOrigin = await host.bindPort(stratumPort, {
    protocol: null,
    addSsl: null,
    preferredExternalPort: stratumPort,
    secure: { ssl: false },
  })
  const stratum = sdk.createInterface(effects, {
    name: i18n('Stratum'),
    id: stratumInterfaceId,
    description: i18n(
      'Point your scrypt ASICs here. One connection mines both chains.',
    ),
    type: 'api',
    masked: false,
    schemeOverride: { ssl: null, noSsl: 'stratum+tcp' },
    username: null,
    path: '',
    query: {},
  })

  return [await uiOrigin.export([ui]), await stratumOrigin.export([stratum])]
})
