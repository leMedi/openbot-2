import type { BotInfo, PluginAccountInfo, PluginInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'

/** A plugin's icon, or its name's first letter when it has none. */
export function PluginIcon({ plugin, size = 36 }: { plugin: PluginInfo; size?: number }) {
  if (plugin.icon) return <img src={`/api${plugin.icon}`} alt="" width={size} height={size} className="shrink-0 rounded-lg" />
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-lg bg-secondary text-lg font-semibold text-muted-foreground"
    >
      {plugin.displayName.charAt(0).toUpperCase()}
    </span>
  )
}

const statuses: Record<PluginInfo['status'], { label: string; className: string }> = {
  not_connected: { label: 'Not connected', className: 'bg-secondary text-muted-foreground' },
  connected: { label: 'Connected', className: 'bg-green/15 text-green-foreground' },
  needs_reconnect: { label: 'Needs reconnect', className: 'bg-destructive/15 text-destructive-foreground' },
}

/** Whether a plugin is connected, as Settings → Plugins shows it. */
export function PluginStatus({ status }: { status: PluginInfo['status'] }) {
  return (
    <span className={cn('shrink-0 rounded-sm px-1.5 text-sm', statuses[status].className)}>{statuses[status].label}</span>
  )
}

/**
 * Whether `bot` may use the account, which the owner switches: granting lets it call the account's tools; revoking
 * takes them away from its next call. `onChanged` gets the account as it now is.
 */
export function GrantSwitch({
  plugin,
  account,
  bot,
  label,
  onChanged,
}: {
  plugin: PluginInfo
  account: PluginAccountInfo
  bot: BotInfo
  /** What the switch names, e.g. the bot in a plugin's view, or the account in a bot's. */
  label: string
  onChanged: (account: PluginAccountInfo) => void
}) {
  const input = { name: plugin.name, account: account.slug, botId: bot.id }
  return (
    <Switch
      label={label}
      on={account.grantedTo.includes(bot.id)}
      change={async (grant) => onChanged(await (grant ? api().plugins.grant(input) : api().plugins.revoke(input)))}
    />
  )
}

/**
 * Whether `bot` may read the skills of `plugin`, one of skills only, which the owner switches; a change shows in its
 * prompt from its next compaction epoch. `onChanged` gets the plugin as it now is.
 */
export function SkillsGrantSwitch({ plugin, bot, label, onChanged }: { plugin: PluginInfo; bot: BotInfo; label: string; onChanged: (plugin: PluginInfo) => void }) {
  const input = { name: plugin.name, botId: bot.id }
  return (
    <Switch
      label={label}
      on={plugin.grantedTo.includes(bot.id)}
      change={async (grant) => onChanged(await (grant ? api().plugins.grantSkills(input) : api().plugins.revokeSkills(input)))}
    />
  )
}

/** A grant's checkbox, `on` when granted; `change` grants or revokes, and its error shows below. */
function Switch({ label, on, change }: { label: string; on: boolean; change: (grant: boolean) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  async function toggle() {
    setSaving(true)
    setError(undefined)
    try {
      await change(!on)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <input type="checkbox" checked={on} disabled={saving} onChange={() => void toggle()} className="size-4 accent-primary" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </span>
      {error && <span className="text-sm text-destructive-foreground">{error}</span>}
    </label>
  )
}
