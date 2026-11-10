import { Linking } from 'react-native'
import type { CheckResult } from '../lib/connect/check.ts'
import { failureMessage } from '../lib/connect/messages.ts'
import { useRecheck } from '../lib/connect/use-recheck.ts'
import { Body, Button, FullScreen, Title } from './ui.tsx'

/** While the owner sets up their instance, checked again this often, so the app moves on by itself once it's done. */
const setupPollMs = 5_000

/**
 * The instance at `url` answered but its onboarding isn't done (spec: Connect flow): setup happens in the browser.
 * Checks again on Check again, on returning to the foreground and every few seconds; every result goes to `onResult`,
 * which moves on once it's set up.
 */
export function FinishSetup({ url, onResult, onChangeAddress }: { url: string; onResult: (result: CheckResult) => void; onChangeAddress: () => void }) {
  const { check, checking, last } = useRecheck(url, onResult, { everyMs: setupPollMs })
  return (
    <FullScreen>
      <Title>Finish setup in the browser</Title>
      <Body>{`OpenBot at ${url} isn't set up yet. Open it in your browser on this phone or your computer, finish setting it up, then come back here.`}</Body>
      {last?.kind === 'failed' && <Body tone="error">{failureMessage(last.failure, last.url)}</Body>}
      <Button label="Open in browser" kind="primary" onPress={() => void Linking.openURL(url)} />
      <Button label="Check again" busy={checking} onPress={() => void check()} />
      <Button label="Use a different address" kind="plain" onPress={onChangeAddress} />
    </FullScreen>
  )
}
