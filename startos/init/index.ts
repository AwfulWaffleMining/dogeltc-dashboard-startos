import { actions } from '../actions'
import { restoreInit } from '../backups'
import { setDependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { sdk } from '../sdk'
import { versionGraph } from '../versions'
import { payoutTask } from './payoutTask'
import { seedFiles } from './seedFiles'

/* Quai's `rewardsTask` is deliberately absent: it polled the chain to settle
 * workshare payouts, and there are no workshares here. `payoutTask` is this
 * package's equivalent shape — an opt-in-or-opt-out the operator must answer —
 * but at 'critical' rather than 'important', because this one decides where
 * money goes. */
export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  setDependencies,
  seedFiles,
  actions,
  payoutTask,
)

export const uninit = sdk.setupUninit(versionGraph)
