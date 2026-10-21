import { payoutConfig } from '../actions/payout'
import { i18n } from '../i18n'
import { sdk } from '../sdk'

/* Hold the service back until the operator has answered the payout question.
 *
 * 'critical' is the severity that blocks starting; 'important' only nags.
 * This one earns it: the whole package exists to pay the operator, and every
 * other failure mode here is recoverable. Mining against an unanswered payout
 * is not — the stratum would hand out work, the rigs would show accepted
 * shares, and the operator would learn the truth on the one day it costs them
 * a block. StartOS can refuse to start it, so it should.
 *
 * Satisfied by ANY of the three real answers, including both ways of saying
 * "do not keep my addresses here". It is an opt-in-or-opt-out, not a demand
 * for addresses: refusing to store them is a complete answer.
 *
 * Declared with 'input-not-matches' rather than cleared by hand. The task is
 * satisfied whenever the action's current input matches an accepted variant,
 * so it disappears the moment a choice is saved and comes back on its own if
 * the operator ever returns to 'unset'. Clearing it manually from the action
 * handler would leave those two paths to drift apart.
 */
export const payoutTask = sdk.setupOnInit(async (effects) => {
  await sdk.action.createOwnTask(effects, payoutConfig, 'critical', {
    when: { once: false, condition: 'input-not-matches' },
    input: {
      kind: 'partial',
      accept: [
        { payout: { selection: 'addresses' } },
        { payout: { selection: 'nodeWallet' } },
        { payout: { selection: 'workerName' } },
      ],
      set: { payout: { selection: 'addresses' } },
    },
    reason: i18n(
      'Choose where a found block pays before mining starts. Save two addresses, pay into the nodes’ own wallets, or decline to store anything and send them per miner — any of the three is a complete answer. There is no default, because a server mining into nowhere looks exactly like a working one until the day you win.',
    ),
  })
})
