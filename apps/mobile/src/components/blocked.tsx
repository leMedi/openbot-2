import { Linking } from 'react-native'
import type { CheckResult } from '../lib/connect/check.ts'
import { useRecheck } from '../lib/connect/use-recheck.ts'
import { Body, Button, FullScreen, Title } from './ui.tsx'

/**
 * The app and the instance at `url` are too far apart in API version to work together (spec: Connect flow): the
 * instance needs updating, or the app does. Nothing else is reachable until they agree; checks again on Check again
 * and on returning to the foreground, every result going to `onResult`.
 */
export function Blocked({
  kind,
  url,
  onResult,
  onChangeAddress,
}: {
  kind: 'instanceTooOld' | 'appTooOld'
  url: string
  onResult: (result: CheckResult) => void
  /** Offered from Connect, where the address isn't kept yet. */
  onChangeAddress?: () => void
}) {
  const { check, checking } = useRecheck(url, onResult)
  return (
    <FullScreen>
      {kind === 'instanceTooOld' ? (
        <>
          <Title>Update OpenBot on your computer</Title>
          <Body>This app needs a newer version of OpenBot than the one at {url}. Update OpenBot, then come back here.</Body>
          <Button label="Open OpenBot" kind="primary" onPress={() => void Linking.openURL(url)} />
        </>
      ) : (
        <>
          <Title>Update the app</Title>
          {/* No store link until there's a store (Shipping the app, #94). */}
          <Body>OpenBot at {url} is newer than this app. Install the latest version of the OpenBot app, then come back here.</Body>
        </>
      )}
      <Button label="Check again" busy={checking} onPress={() => void check()} />
      {onChangeAddress && <Button label="Use a different address" kind="plain" onPress={onChangeAddress} />}
    </FullScreen>
  )
}
