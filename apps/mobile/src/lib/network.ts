import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network'
import { useEffect, useLayoutEffect, useRef } from 'react'

/** What a change of network is told by: the kind of network (Wi-Fi, cellular…) and whether there is one. */
const networkOf = (state: NetworkState) => `${state.type ?? 'unknown'}:${state.isConnected ?? 'unknown'}`

/**
 * Calls the latest `onChange` when the phone's network changes: it joins one, loses it, or moves between Wi-Fi and
 * cellular. Not for the network the app starts on.
 */
export function useNetworkChanges(onChange: () => void) {
  const latest = useRef(onChange)
  useLayoutEffect(() => {
    latest.current = onChange
  })
  useEffect(() => {
    let known: string | undefined
    const note = (state: NetworkState) => {
      const now = networkOf(state)
      if (known !== undefined && now !== known) latest.current()
      known = now
    }
    void getNetworkStateAsync().then((state) => known ?? note(state), () => {})
    const subscription = addNetworkStateListener(note)
    return () => subscription.remove()
  }, [])
}
