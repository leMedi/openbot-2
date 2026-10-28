import type { PluginInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'

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
