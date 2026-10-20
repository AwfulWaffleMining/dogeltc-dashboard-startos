import { actions } from '../actions'
import { restoreInit } from '../backups'
import { setDependencies } from '../dependencies'
import { setInterfaces } from '../interfaces'
import { sdk } from '../sdk'
import { versionGraph } from '../versions'
import { seedFiles } from './seedFiles'

/* Quai's `rewardsTask` is deliberately absent: it polled the chain to settle
 * workshare payouts, and there are no workshares here. */
export const init = sdk.setupInit(
  restoreInit,
  versionGraph,
  setInterfaces,
  setDependencies,
  seedFiles,
  actions,
)

export const uninit = sdk.setupUninit(versionGraph)
