import { randomBytes } from 'node:crypto'
import { storeJson } from '../fileModels/store.json'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

const { InputSpec, Value, Variants } = sdk

/* Address shapes, used to catch the realistic mistake rather than to be
 * authoritative.
 *
 * The node that has to pay the address is the real validator — litecoind's
 * `validateaddress`, and dogecoind's `createauxblock`, which refuses a bad
 * payout address with "Invalid coinbase payout address". The stratum calls
 * both at startup and refuses to serve work if either is rejected, so a
 * malformed address cannot reach a coinbase.
 *
 * What these patterns buy is catching the swap at the moment of typing, when
 * the operator can still see which box they were in. Pasting the LTC address
 * into the DOGE field and vice versa is the error this design is most exposed
 * to, because both are base58 strings of similar length and the config asks
 * for them side by side. */
const LTC_ADDRESS =
  '^(ltc1[02-9ac-hj-np-z]{6,70}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$'
const DOGE_ADDRESS = '^[DA9][a-km-zA-HJ-NP-Z1-9]{25,34}$'

export const payoutConfig = sdk.Action.withInput(
  'payout-config',

  async ({ effects }) => ({
    name: i18n('Payouts'),
    description: i18n(
      'Decide where a found block pays. Mining does not start until this is set.',
    ),
    warning: null,
    allowedStatuses: 'any',
    group: null,
    visibility: 'enabled',
  }),

  InputSpec.of({
    payout: Value.union({
      name: i18n('Where blocks pay'),
      description: i18n(
        'This has no working default on purpose. Choosing deliberately is what stops a half-finished setup from mining into nowhere.',
      ),
      warning: null,
      default: 'unset',
      variants: Variants.of({
        unset: {
          name: i18n('Not chosen yet — mining is disabled'),
          spec: InputSpec.of({}),
        },
        addresses: {
          name: i18n('Pay to addresses I control'),
          spec: InputSpec.of({
            ltcAddress: Value.text({
              name: i18n('Litecoin address'),
              description: i18n(
                'Where a found Litecoin block pays. Starts with L, M or ltc1.',
              ),
              required: true,
              default: null,
              patterns: [
                {
                  regex: LTC_ADDRESS,
                  description: i18n(
                    'Must be a Litecoin address (L…, M… or ltc1…). A Dogecoin address will be refused here.',
                  ),
                },
              ],
            }),
            dogeAddress: Value.text({
              name: i18n('Dogecoin address'),
              description: i18n(
                'Where a found Dogecoin block pays. Starts with D, A or 9.',
              ),
              required: true,
              default: null,
              patterns: [
                {
                  regex: DOGE_ADDRESS,
                  description: i18n(
                    'Must be a Dogecoin address (D…, A… or 9…). A Litecoin address will be refused here.',
                  ),
                },
              ],
            }),
          }),
        },
        nodeWallet: {
          name: i18n("Pay into each node's own wallet"),
          spec: InputSpec.of({}),
        },
      }),
    }),
  }),

  async ({ effects }) => {
    const s = await storeJson.read().once()
    if (!s || s.payoutMode === 'unset') return null
    return {
      payout:
        s.payoutMode === 'addresses'
          ? {
              selection: 'addresses' as const,
              value: { ltcAddress: s.ltcAddress, dogeAddress: s.dogeAddress },
            }
          : { selection: 'nodeWallet' as const, value: {} },
    }
  },

  async ({ effects, input }) => {
    const sel = input.payout.selection
    const existing = await storeJson.read().once()

    if (sel === 'unset') {
      await storeJson.merge(effects, {
        payoutMode: 'unset',
        ltcAddress: '',
        dogeAddress: '',
      })
      return {
        version: '1' as const,
        title: i18n('Mining stays disabled'),
        message: i18n(
          'No payout destination is set, so the stratum will not accept miners. Choose one when you are ready.',
        ),
        result: null,
      }
    }

    /* Generated once and kept. Regenerating it on every save would change the
     * worker names operators have already configured on their rigs, and
     * silently split their metering history in two. */
    const workerAccount =
      existing?.workerAccount || `awm${randomBytes(3).toString('hex')}`

    if (sel === 'nodeWallet') {
      await storeJson.merge(effects, {
        payoutMode: 'nodeWallet',
        /* Cleared rather than kept: someone opting out should not leave an
         * address behind in store.json. The absence is the point. */
        ltcAddress: '',
        dogeAddress: '',
        workerAccount,
      })
      return {
        version: '1' as const,
        title: i18n('Paying into the node wallets'),
        message: i18n(
          'Each block will pay to a fresh address from that chain’s own node wallet. Nothing is stored here. Back up both nodes: their wallet files become the only record of what you have been paid, and a found block cannot be recovered without them.',
        ),
        result: {
          type: 'single' as const,
          value: `${workerAccount}.rig1`,
          copyable: true,
          masked: false,
          qr: false,
        },
      }
    }

    const { ltcAddress, dogeAddress } = input.payout.value
    await storeJson.merge(effects, {
      payoutMode: 'addresses',
      ltcAddress,
      dogeAddress,
      workerAccount,
    })

    return {
      version: '1' as const,
      title: i18n('Payout addresses saved'),
      message: i18n(
        'Both nodes will be asked to confirm these addresses when the stratum starts; if either refuses one, mining stops and the dashboard says which. Point your miners at this worker name, changing the part after the dot per rig.',
      ),
      result: {
        type: 'single' as const,
        value: `${workerAccount}.rig1`,
        copyable: true,
        masked: false,
        qr: false,
      },
    }
  },
)
