import { FileHelper, z } from '@start9labs/start-sdk'
import { sdk } from '../sdk'

export const shape = z
  .object({
    /* How a found block pays.
     *
     * 'unset' is the SHIPPED state and is not a working configuration. The
     * stratum refuses to accept miners while it holds, and the dashboard says
     * which choice to make. That is deliberate: a blank address field cannot
     * distinguish "I chose the node wallet" from "I did not finish filling
     * this in", and the second of those produces a rig that looks healthy —
     * stratum up, shares accepted, hashrate graphed — right up until a block
     * is found and there is nowhere to pay it.
     *
     * 'addresses' pays to addresses the operator controls, off this server.
     *
     * The real axis is custody, not privacy. Either way the address ends up
     * in a coinbase transaction and is public forever; what differs is
     * whether coins land somewhere already under the operator's control or in
     * a hot wallet on an internet-facing mining box whose wallet.dat then
     * becomes the one irreplaceable thing in the backup. A static configured
     * address is in fact the WORSE of the two for on-chain privacy, since
     * every block found links to it, while getnewaddress rotates. */
    payoutMode: z.enum(['unset', 'addresses', 'workerName']).catch('unset'),

    /* Only populated under payoutMode 'addresses'. Someone who picks
     * 'workerName' has no address stored here at all — structurally, not by
     * convention. Both are validated by the node that will have to pay them
     * before they are accepted: litecoind's `validateaddress` and dogecoin's
     * `createauxblock`, which rejects a bad payout address itself. */
    ltcAddress: z.string().catch(''),
    dogeAddress: z.string().catch(''),

    /* The `account` half of the `account.rig` worker-name convention,
     * generated once so operators never paste an address into a worker field.
     *
     * That matters for firmware, not just taste. The pool convention of
     * `LTC_ADDRESS,DOGE_ADDRESS.RIG_ID` is around 85 characters with a comma
     * in it, and Canaan/Avalon firmware rejects commas in these fields while
     * others truncate silently. Short and alphanumeric with a single dot is
     * the shape every implementation already handles. */
    workerAccount: z.string().catch(''),

    /* Vardiff and reporting knobs, surfaced so an operator can tune without
     * editing environment by hand. Defaults match the values the stratum was
     * hardware-validated with. */
    vardiffTargetSeconds: z.number().int().min(2).max(120).catch(15),
    reportSeconds: z.number().int().min(0).max(3600).catch(60),
  })
  .strip()

export const storeJson = FileHelper.json(
  {
    base: sdk.volumes.main,
    subpath: '/dashboard/store.json',
  },
  shape,
)
