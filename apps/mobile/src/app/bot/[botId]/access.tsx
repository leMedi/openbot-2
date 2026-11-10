import type { PluginAccountInfo, PluginInfo } from '@openbot/api-contract'
import { accessPlugins, useLive } from '@openbot/client'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { Alert } from 'react-native'
import { GrantSwitch } from '../../../components/grant-switch.tsx'
import { Group, GroupedScroll, Loading, Note, Row } from '../../../components/grouped.tsx'
import { PluginIcon } from '../../../components/plugin-icon.tsx'
import { SwipeRow } from '../../../components/swipe-row.tsx'
import { errorMessage } from '../../../lib/errors.ts'
import { useInstance } from '../../../lib/instance-context.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'

/**
 * A bot's Access, as the web's pane: each plugin with a connected account, or of skills only, and whether the bot may
 * use each account (or the skills), switched here; swiping a granted account left revokes it. Plugins not connected
 * yet are counted, with the way to Settings → Plugins to connect them.
 */
export default function Access() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const live = useLive()
  const { api } = useInstance()
  const bot = live.bots?.find((each) => each.id === botId)
  const plugins = useLoadOnFocus(useCallback(() => api.plugins.list(), [api]))
  const access = plugins.data && accessPlugins(plugins.data)
  const name = bot?.name ?? 'The bot'

  const replace = (saved: PluginInfo) => plugins.setData((plugins.data ?? []).map((each) => (each.name === saved.name ? saved : each)))
  const accountChanged = (plugin: PluginInfo, account: PluginAccountInfo) =>
    replace({ ...plugin, accounts: plugin.accounts.map((each) => (each.slug === account.slug ? account : each)) })
  const setAccount = async (plugin: PluginInfo, account: PluginAccountInfo, grant: boolean) => {
    const input = { name: plugin.name, account: account.slug, botId }
    accountChanged(plugin, await (grant ? api.plugins.grant(input) : api.plugins.revoke(input)))
  }
  const setSkills = async (plugin: PluginInfo, grant: boolean) => {
    const input = { name: plugin.name, botId }
    replace(await (grant ? api.plugins.grantSkills(input) : api.plugins.revokeSkills(input)))
  }
  const revoke = (work: Promise<void>) => void work.catch((caught) => Alert.alert(`Couldn't take it back from ${name}`, errorMessage(caught)))

  return (
    <>
      <Stack.Screen options={{ title: 'Access' }} />
      <GroupedScroll>
        <Note>{`The plugin accounts and skills ${name} may use. Revoking an account takes effect from its next call; skills change when its history is next compacted.`}</Note>
        {plugins.error && !plugins.data && <Note tone="error">{`Couldn't load the plugins: ${plugins.error}`}</Note>}
        {!plugins.data && !plugins.error && <Loading />}
        {access && !access.grantable.length && <Note>No plugin has an account or skills to grant yet.</Note>}
        {bot &&
          access?.grantable.map((plugin) => (
            <Group key={plugin.name}>
              <Row
                label={plugin.displayName}
                detail={plugin.status === 'needs_reconnect' ? 'Needs reconnect, in Settings → Plugins' : plugin.servers.length ? undefined : 'Skills only, no account'}
                icon={<PluginIcon plugin={plugin} size={28} />}
                onPress={() => router.push({ pathname: '/settings/plugins/[name]', params: { name: plugin.name } })}
              />
              {plugin.accounts.map((account) => {
                const granted = account.grantedTo.includes(botId)
                return (
                  <SwipeRow key={account.slug} label="Revoke" disabled={!granted} onAction={() => revoke(setAccount(plugin, account, false))}>
                    <GrantSwitch bot={bot} label={account.displayName} on={granted} change={(grant) => setAccount(plugin, account, grant)} />
                  </SwipeRow>
                )
              })}
              {!plugin.servers.length && (
                <SwipeRow label="Revoke" disabled={!plugin.grantedTo.includes(botId)} onAction={() => revoke(setSkills(plugin, false))}>
                  <GrantSwitch bot={bot} label="Its skills" on={plugin.grantedTo.includes(botId)} change={(grant) => setSkills(plugin, grant)} />
                </SwipeRow>
              )}
            </Group>
          ))}
        {access && access.unconnected > 0 && (
          <Group note={`${access.unconnected} more ${access.unconnected === 1 ? 'plugin is' : 'plugins are'} not connected yet.`}>
            <Row label="Connect plugins in Settings" tone="link" onPress={() => router.push('/settings/plugins')} />
          </Group>
        )}
      </GroupedScroll>
    </>
  )
}
