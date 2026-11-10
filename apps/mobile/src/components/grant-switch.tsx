import type { BotInfo } from '@openbot/api-contract'
import { useState } from 'react'
import { Alert } from 'react-native'
import { errorMessage } from '../lib/errors.ts'
import { SwitchRow } from './grouped.tsx'

/** Whether `bot` is granted the account or the plugin, switched at once; the switch waits for the instance. */
export function GrantSwitch({ bot, label = bot.name, on, change }: { bot: Pick<BotInfo, 'name'>; label?: string; on: boolean; change: (grant: boolean) => Promise<void> }) {
  const [saving, setSaving] = useState<boolean>()
  return (
    <SwitchRow
      label={label}
      value={saving ?? on}
      disabled={saving !== undefined}
      onChange={(grant) => {
        setSaving(grant)
        change(grant)
          .catch((caught) => Alert.alert(grant ? `Couldn't grant it to ${bot.name}` : `Couldn't take it back from ${bot.name}`, errorMessage(caught)))
          .finally(() => setSaving(undefined))
      }}
    />
  )
}
