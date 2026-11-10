import type { SavedInstance } from '../saved-instance.ts'
import type { CheckResult } from './check.ts'

/** What Edit address does with a check of the new address (spec: Connect flow, Settings → Instance). */
export type AddressChange =
  /** The address that answered is the one in use: nothing to do. */
  | { kind: 'unchanged' }
  /** The same instance at another address: switch to it, keeping this phone's cache and drafts. */
  | { kind: 'sameInstance'; instance: SavedInstance }
  /** Another instance: switch only once the owner agrees to lose this phone's cache, drafts and notifications. */
  | { kind: 'otherInstance'; instance: SavedInstance }
  /** It can't be used; the current address stays. */
  | Exclude<CheckResult, { kind: 'connected' }>

/** Decides what a check of a new address means for the instance in use, `current`. */
export function addressChange(current: SavedInstance, result: CheckResult): AddressChange {
  if (result.kind !== 'connected') return result
  if (result.url === current.url && result.instanceId === current.instanceId) return { kind: 'unchanged' }
  const instance = { url: result.url, instanceId: result.instanceId, setUp: result.setUp }
  return { kind: result.instanceId === current.instanceId ? 'sameInstance' : 'otherInstance', instance }
}
