import { type DeviceInfo, type GeneralSettings, maxOwnerAboutLength, maxOwnerNameLength } from '@openbot/api-contract'
import { notifiedFor, offsetOf, platformNames } from '@openbot/client'
import { router, Stack } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { FieldRow, Group, GroupedScroll, Loading, Note, Row } from '../../components/grouped.tsx'
import { errorMessage } from '../../lib/errors.ts'
import { useInstance } from '../../lib/instance-context.ts'
import { useLoadOnFocus } from '../../lib/use-load.ts'
import { useSaveSoon } from '../../lib/use-save-soon.ts'

/**
 * Settings → General, as the web's: who the owner is to their bots (name and about, saved as they type, as the
 * sketch has it), their time zone (pushed picker), and the phones registered for notifications, each removable.
 */
export default function General() {
  const { api } = useInstance()
  const settings = useLoadOnFocus(useCallback(() => api.general.getSettings(), [api]))
  const devices = useLoadOnFocus(useCallback(() => api.devices.list(), [api]))

  const removeDevice = (device: DeviceInfo) =>
    Alert.alert(`Remove ${device.name}?`, 'It gets no more notifications until the OpenBot app on it registers again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void api.devices
            .remove({ deviceId: device.id })
            .then(() => devices.setData((devices.data ?? []).filter((each) => each.id !== device.id)))
            .catch((caught) => Alert.alert("Couldn't remove it", errorMessage(caught))),
      },
    ])

  const timeZone = settings.data?.timeZone
  return (
    <>
      <Stack.Screen options={{ title: 'General' }} />
      <GroupedScroll>
        {settings.error && !settings.data && <Note tone="error">{`Couldn't load your settings: ${settings.error}`}</Note>}
        {!settings.data && !settings.error && <Loading />}
        {settings.data && <AboutYou settings={settings.data} onSaved={settings.setData} />}
        {settings.data && (
          <Group label="Time zone" note="Routines and memory consolidation follow it.">
            <Row
              label="Time zone"
              value={timeZone ? `${timeZone.replaceAll('_', ' ')} (${offsetOf(timeZone)})` : 'Not set (UTC)'}
              onPress={() => router.push('/settings/time-zone')}
            />
          </Group>
        )}
        <Group
          label="Phones"
          note={
            devices.error
              ? `Couldn't load your phones: ${devices.error}`
              : devices.data?.length === 0
                ? 'No phones yet. They appear here once the OpenBot app turns notifications on.'
                : 'Phones with the OpenBot app get notifications. Each phone chooses what notifies it. Tap one to remove it.'
          }
        >
          {devices.data?.map((device) => (
            <Row
              key={device.id}
              label={device.name}
              detail={`${platformNames[device.platform]} · added ${new Date(device.createdAt).toLocaleDateString()} · ${notifiedFor(device)}`}
              accessibilityLabel={`Remove ${device.name}`}
              onPress={() => removeDevice(device)}
            />
          ))}
        </Group>
      </GroupedScroll>
    </>
  )
}

/** The owner's name and about, which every bot reads; each saved when its field is left. */
function AboutYou({ settings, onSaved }: { settings: GeneralSettings; onSaved: (settings: GeneralSettings) => void }) {
  const { api } = useInstance()
  const [name, setName] = useState(settings.name ?? '')
  const [about, setAbout] = useState(settings.about)
  const [status, setStatus] = useState<{ saving: boolean; error?: string }>({ saving: false })
  const editing = useRef(false)
  // Saves go one after another, so they land in the order the owner made them.
  const queue = useRef(Promise.resolve())

  // Changed elsewhere (the web): shown as it is, unless the owner is typing.
  useEffect(() => {
    if (editing.current) return
    setName(settings.name ?? '')
    setAbout(settings.about)
  }, [settings.name, settings.about])

  const save = (changes: { name?: string; about?: string }) => {
    setStatus({ saving: true })
    queue.current = queue.current.then(async () => {
      try {
        onSaved(await api.general.updateProfile(changes))
        setStatus({ saving: false })
      } catch (caught) {
        setStatus({ saving: false, error: errorMessage(caught) })
      }
    })
  }

  const saveName = useSaveSoon((final) => {
    if (final) editing.current = false
    const trimmed = name.trim()
    // A bot needs something to call the owner: an emptied name puts the old one back once the field is left.
    if (!trimmed) return final && setName(settings.name ?? '')
    if (trimmed !== settings.name) save({ name: trimmed })
  })
  const saveAbout = useSaveSoon((final) => {
    if (final) editing.current = false
    if (about.trim() !== settings.about) save({ about: about.trim() })
  })

  return (
    <Group
      label="About you"
      note={status.error ? `Couldn't save: ${status.error}` : status.saving ? 'Saving…' : 'Every bot reads this before it works for you, from its next run.'}
    >
      <FieldRow
        label="Name"
        value={name}
        onChangeText={(value) => {
          setName(value)
          saveName.soon()
        }}
        onFocus={() => (editing.current = true)}
        onEndEditing={saveName.now}
        maxLength={maxOwnerNameLength}
        placeholder="What your bots call you"
        returnKeyType="done"
        autoCorrect={false}
      />
      <FieldRow
        accessibilityLabel="About"
        value={about}
        onChangeText={(value) => {
          setAbout(value)
          saveAbout.soon()
        }}
        onFocus={() => (editing.current = true)}
        onEndEditing={saveAbout.now}
        maxLength={maxOwnerAboutLength}
        multiline
        placeholder="What you do, where you're based, how you like things done."
      />
    </Group>
  )
}
