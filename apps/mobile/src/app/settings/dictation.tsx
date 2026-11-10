import { Stack } from 'expo-router'
import { Alert, StyleSheet } from 'react-native'
import { ModelProgress, useCellularChoice } from '../../components/dictation.tsx'
import { Group, GroupedScroll, Row, SwitchRow } from '../../components/grouped.tsx'
import { releaseModel } from '../../lib/dictation/engine.ts'
import { modelStatus } from '../../lib/dictation/model-download.ts'
import { modelDownload, useModelState, voiceModel } from '../../lib/dictation/model.ts'

/**
 * Settings → This phone → Dictation (spec: Dictation): the voice model on this phone, its download's progress, and
 * Delete model. The mic offers the download too, the first time it's tapped.
 */
export default function DictationSettings() {
  const model = useModelState()
  const [cellular, setCellular] = useCellularChoice()

  const confirmDelete = () =>
    Alert.alert('Delete the voice model?', `Dictation stops working until you download it again (${voiceModel.size}), which the mic offers.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          releaseModel()
          modelDownload.remove()
        },
      },
    ])

  return (
    <>
      <Stack.Screen options={{ title: 'Dictation' }} />
      <GroupedScroll>
        <Group
          label="Voice model"
          note="Dictation runs on your phone: what you say is transcribed here and never leaves it, and your OpenBot doesn't know you dictated. English only."
        >
          <Row label={voiceModel.name} detail={voiceModel.size} value={modelStatus(model)} />
          {model.kind === 'downloading' && <ModelProgress fraction={model.fraction} style={styles.progress} />}
          {model.kind === 'failed' && <Row label={model.message} disabled />}
        </Group>
        {model.kind !== 'ready' && (
          <Group note="Without it, the voice model downloads on Wi-Fi only, and waits for Wi-Fi on cellular.">
            <SwitchRow label="Use cellular data" value={cellular} onChange={setCellular} />
          </Group>
        )}
        <Group>
          {model.kind === 'absent' && <Row label={`Download (${voiceModel.size})`} tone="link" onPress={() => modelDownload.start({ cellular: cellular })} />}
          {model.kind === 'failed' && <Row label="Try again" tone="link" onPress={() => modelDownload.start({ cellular: cellular })} />}
          {(model.kind === 'downloading' || model.kind === 'failed') && <Row label="Cancel download" tone="danger" onPress={() => modelDownload.cancel()} />}
          {model.kind === 'ready' && <Row label="Delete model" tone="danger" onPress={confirmDelete} />}
        </Group>
      </GroupedScroll>
    </>
  )
}

const styles = StyleSheet.create({
  progress: { marginHorizontal: 16, marginBottom: 12 },
})
