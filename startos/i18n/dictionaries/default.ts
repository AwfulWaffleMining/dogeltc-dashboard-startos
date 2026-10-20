export const DEFAULT_LANG = 'en_US'

/* Ids are STABLE and must never be renumbered: translations.ts maps id to
 * foreign string, so reassigning an id silently mistranslates that message.
 * Generated from the i18n() calls in the code — regenerate, do not edit. */
const dict = {
  Payouts: 0,
  'Decide where a found block pays. Mining does not start until this is set.': 1,
  'Where blocks pay': 2,
  'This has no working default on purpose. Choosing deliberately is what stops a half-finished setup from mining into nowhere.': 3,
  'Not chosen yet — mining is disabled': 4,
  'Pay to addresses I control': 5,
  'Litecoin address': 6,
  'Where a found Litecoin block pays. Starts with L, M or ltc1.': 7,
  'Must be a Litecoin address (L…, M… or ltc1…). A Dogecoin address will be refused here.': 8,
  'Dogecoin address': 9,
  'Where a found Dogecoin block pays. Starts with D, A or 9.': 10,
  'Must be a Dogecoin address (D…, A… or 9…). A Litecoin address will be refused here.': 11,
  "Pay into each node's own wallet": 12,
  'Mining stays disabled': 13,
  'No payout destination is set, so the stratum will not accept miners. Choose one when you are ready.': 14,
  'Paying into the node wallets': 15,
  'Each block will pay to a fresh address from that chain’s own node wallet. Nothing is stored here. Back up both nodes: their wallet files become the only record of what you have been paid, and a found block cannot be recovered without them.': 16,
  'Payout addresses saved': 17,
  'Both nodes will be asked to confirm these addresses when the stratum starts; if either refuses one, mining stops and the dashboard says which. Point your miners at this worker name, changing the part after the dot per rig.': 18,
  'Mining Dashboard': 19,
  'Hashrate, workers, blocks found, share luck, and the settings for your miners': 20,
  'Starting scrypt solo mining': 21,
  'Cannot reach the ${chain} node over RPC': 22,
  Stratum: 23,
  'Set a payout destination before mining starts': 24,
  'Accepting miners': 25,
  'The stratum is starting': 26,
  Dashboard: 27,
  'The dashboard is ready': 28,
  'The dashboard is starting': 29,
} as const

/**
 * Plumbing. DO NOT EDIT.
 */
export type I18nKey = keyof typeof dict
export type LangDict = Record<(typeof dict)[I18nKey], string>
export default dict
