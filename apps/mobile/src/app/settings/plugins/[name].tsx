import { type PluginAccountInfo, type PluginInfo, pluginAccountNameMax } from '@openbot/api-contract'
import { pluginStatusLabels, useLive } from '@openbot/client'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { GrantSwitch } from '../../../components/grant-switch.tsx'
import { Group, GroupedScroll, Loading, Note, Row } from '../../../components/grouped.tsx'
import { PluginIcon } from '../../../components/plugin-icon.tsx'
import { Prompt, type PromptRequest } from '../../../components/prompt.tsx'
import { errorMessage } from '../../../lib/errors.ts'
import { useInstance } from '../../../lib/instance-context.ts'
import { openOnWeb } from '../../../lib/open-on-web.ts'
import { useColors } from '../../../lib/theme.ts'
import { useLoadOnFocus } from '../../../lib/use-load.ts'

/**
 * A plugin's screen in Settings → Plugins, as the web's detail view: what it is and its status; its accounts, each
 * with the bots granted it (switches), Rename, Reconnect once its sign-in expired, and Disconnect; Connect (another
 * account); or, for a plugin of skills only, the bots granted it; then its servers and skills. Connect and Reconnect
 * open the plugin on the web.
 */
export default function Plugin() {
  const { name } = useLocalSearchParams<{ name: string }>()
  const { api, url } = useInstance()
  const { bots } = useLive()
  const colors = useColors()
  const loaded = useLoadOnFocus(useCallback(() => api.plugins.get({ name }), [api, name]))
  const [prompt, setPrompt] = useState<PromptRequest>()
  const plugin = loaded.data

  // Signing in leaves the app for the browser, where Android cuts the app's connection, and the instance cancels a
  // sign-in whose stream closes: so it runs in the web's wizard, in the browser, and this screen reloads on return.
  const signIn = () => openOnWeb(url, `/settings/plugins/${encodeURIComponent(name)}`)

  const accountChanged = (account: PluginAccountInfo) =>
    plugin && loaded.setData({ ...plugin, accounts: plugin.accounts.map((each) => (each.slug === account.slug ? account : each)) })

  const rename = (account: PluginAccountInfo) =>
    setPrompt({
      title: 'Rename account',
      initial: account.displayName,
      maxLength: pluginAccountNameMax,
      confirm: 'Save',
      save: async (displayName) => {
        if (displayName !== account.displayName) accountChanged(await api.plugins.renameAccount({ name, account: account.slug, displayName }))
      },
    })

  const disconnect = (plugin: PluginInfo, account: PluginAccountInfo) =>
    Alert.alert(
      `Disconnect ${plugin.displayName} (${account.displayName})?`,
      "OpenBot forgets this account's sign-in, and the bots granted it lose its tools. Connecting it again gives it a new slug, so bots see it as a new account.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () =>
            void api.plugins
              .disconnectAccount({ name, account: account.slug })
              .then(loaded.reload)
              .catch((caught) => Alert.alert("Couldn't disconnect it", errorMessage(caught))),
        },
      ],
    )

  return (
    <>
      <Stack.Screen options={{ title: plugin?.displayName ?? '' }} />
      <GroupedScroll>
        {loaded.error && !plugin && <Note tone="error">{`Couldn't load this plugin: ${loaded.error}`}</Note>}
        {!plugin && !loaded.error && <Loading />}
        {plugin && (
          <>
            <View style={styles.hero}>
              <PluginIcon plugin={plugin} size={56} />
              <Text style={[styles.title, { color: colors.foreground }]}>{plugin.displayName}</Text>
              <Text style={[styles.status, { color: statusColor(plugin.status, colors) }]}>{pluginStatusLabels[plugin.status]}</Text>
              <Text style={[styles.description, { color: colors.mutedForeground }]}>{plugin.description}</Text>
              {plugin.version && <Text style={[styles.version, { color: colors.faint }]}>Version {plugin.version}</Text>}
            </View>

            {plugin.accounts.map((account) => (
              <Group
                key={account.slug}
                label={account.needsReconnect ? `${account.displayName} · needs reconnect` : account.displayName}
                note={`${account.slug} · connected ${new Date(account.connectedAt).toLocaleDateString()}${bots?.length ? '. Switch on the bots that may use it.' : ''}`}
              >
                {bots?.map((bot) => (
                  <GrantSwitch
                    key={bot.id}
                    bot={bot}
                    on={account.grantedTo.includes(bot.id)}
                    change={async (grant) => {
                      const input = { name, account: account.slug, botId: bot.id }
                      accountChanged(await (grant ? api.plugins.grant(input) : api.plugins.revoke(input)))
                    }}
                  />
                ))}
                {account.needsReconnect && <Row label="Reconnect" tone="link" external onPress={signIn} />}
                <Row label="Rename" tone="link" onPress={() => rename(account)} />
                <Row label="Disconnect" tone="danger" onPress={() => disconnect(plugin, account)} />
              </Group>
            ))}

            {plugin.servers.length > 0 ? (
              <Group
                note={`${plugin.accounts.length ? '' : `No ${plugin.displayName} account is connected yet. `}Signing in to an account happens in the browser.`}
              >
                <Row label={plugin.accounts.length ? 'Connect another account' : 'Connect'} tone="link" external onPress={signIn} />
              </Group>
            ) : (
              <Group
                label="Bots that may use its skills"
                note={`${plugin.displayName} needs no account: it brings skills only. A change shows from each bot's next compaction.`}
              >
                {bots?.map((bot) => (
                  <GrantSwitch
                    key={bot.id}
                    bot={bot}
                    on={plugin.grantedTo.includes(bot.id)}
                    change={async (grant) => {
                      const input = { name, botId: bot.id }
                      loaded.setData(await (grant ? api.plugins.grantSkills(input) : api.plugins.revokeSkills(input)))
                    }}
                  />
                ))}
              </Group>
            )}

            {plugin.servers.length > 0 && (
              <Group label={plugin.servers.length > 1 ? 'Servers' : 'Server'}>
                {plugin.servers.map((server) => (
                  <Row key={server.name} label={server.url} />
                ))}
              </Group>
            )}

            {plugin.skills.length > 0 && (
              <Group label="Skills">
                {plugin.skills.map((skill) => (
                  <Row key={skill.name} label={skill.name} detail={skill.description} />
                ))}
              </Group>
            )}
          </>
        )}
      </GroupedScroll>
      <Prompt request={prompt} onClose={() => setPrompt(undefined)} />
    </>
  )
}

function statusColor(status: PluginInfo['status'], colors: ReturnType<typeof useColors>): string {
  if (status === 'connected') return colors.greenForeground
  if (status === 'needs_reconnect') return colors.destructiveForeground
  return colors.mutedForeground
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 4, paddingHorizontal: 12 },
  title: { fontSize: 22, fontWeight: '600', marginTop: 8 },
  status: { fontSize: 13, fontWeight: '500' },
  description: { fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 4 },
  version: { fontSize: 12 },
})
