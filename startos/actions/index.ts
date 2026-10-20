import { sdk } from '../sdk'
import { payoutConfig } from './payout'

/* Quai's `confirmedRewards` action is deliberately absent. It existed to
 * reconcile workshare payouts against the chain — work that met a lower
 * threshold, was included in someone else's block, and paid a fraction. No
 * such concept exists on Litecoin or Dogecoin: a share either meets the
 * network target and is a block, or it is not. */
export const actions = sdk.Actions.of().addAction(payoutConfig)
