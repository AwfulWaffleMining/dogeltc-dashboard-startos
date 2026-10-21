import { config as dogecoinConfig } from 'dogecoin-startos/startos/actions/config'
import { config as litecoinConfig } from 'litecoin-startos/startos/actions/config'
import { i18n } from '../i18n'
import { sdk } from '../sdk'
import { dogecoin, litecoin } from '../utils'

/* Both nodes must be sharing their RPC, and neither does by default.
 *
 * `shareRpc` is a toggle in each node package's own config, defaulting to
 * false, and it is what decides whether that package binds and exports its
 * RPC host at all. Until it is on, `sdk.host.getBridgeAddress` for that node
 * answers null — the node is running, synced, and completely unreachable
 * from here.
 *
 * `checkDependencies` does NOT cover this. It is satisfied by the node being
 * running and synced, which it is, so main() sailed past it and then threw on
 * the address lookup, once every ten seconds, forever. Both tasks are
 * therefore 'critical': without them the service cannot work at all, and a
 * task that says so is worth more than a retry loop that does not.
 *
 * Declared with an accept list rather than read from the node's store, which
 * this package cannot see: StartOS satisfies the task when that node's own
 * config input already has the toggle on, and shows it otherwise.
 */
const needsRpc = [
  { pkg: litecoin.packageId, action: litecoinConfig, label: 'Litecoin' },
  { pkg: dogecoin.packageId, action: dogecoinConfig, label: 'Dogecoin' },
] as const

export const rpcTask = sdk.setupOnInit(async (effects) => {
  for (const { pkg, action, label } of needsRpc) {
    await sdk.action.createTask(effects, pkg, action, 'critical', {
      input: {
        kind: 'partial',
        accept: [{ shareRpc: true }],
        set: { shareRpc: true },
      },
      reason: i18n(
        'Merge mining builds every block from your ${chain} node, so it has to let other packages on this server talk to it. Open this node’s config, turn on “Share node RPC with other packages” and save. Nothing leaves your server: the RPC stays on the local network, and the mining service reads this node’s own cookie file for the password rather than being given one.',
        { chain: label },
      ),
    })
  }
})
