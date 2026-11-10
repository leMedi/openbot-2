import { createContext, useContext } from 'react'
import type { CheckResult } from './connect/check.ts'

/** The instance the app is on, for screens that reach it outside the live store. */
export type InstanceInfo = {
  url: string
  /** Hands over a check of the instance made elsewhere (the banner's diagnosis), which may find a version block. */
  noteCheck: (result: CheckResult) => void
}

export const InstanceContext = createContext<InstanceInfo | undefined>(undefined)

export function useInstance(): InstanceInfo {
  const instance = useContext(InstanceContext)
  if (!instance) throw new Error('useInstance needs an instance')
  return instance
}
