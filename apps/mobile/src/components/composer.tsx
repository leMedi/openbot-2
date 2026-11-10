import { maxAttachments } from '@openbot/api-contract'
import { attachmentKind, useLive } from '@openbot/client'
import { Image } from 'expo-image'
import { useEffect, useRef, useState } from 'react'
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, type TextInputInstance, View } from 'react-native'
import { insertDictation, type Selection } from '../lib/dictation/text.ts'
import { useDictation } from '../lib/dictation/use-dictation.ts'
import { errorMessage } from '../lib/errors.ts'
import { chooseFiles, pickFromLibrary, takePhoto } from '../lib/files.ts'
import { useColors } from '../lib/theme.ts'
import type { PickedFile } from '../lib/upload.ts'
import { ActionSheet, type SheetContent } from './action-sheet.tsx'
import { FileChip } from './attachments.tsx'
import { DictationToastView, ListeningBar, MicButton, ModelSheet, TranscribingBar } from './dictation.tsx'
import { CloseIcon, PlusIcon, SendIcon } from './icons.tsx'

/** A picked photo in the composer or going out: its thumbnail, a × while in the composer, and its upload's progress. */
export function PickedThumb({ file, onRemove, progress, dimmed = false }: { file: PickedFile; onRemove?: () => void; progress?: number; dimmed?: boolean }) {
  const colors = useColors()
  return (
    <View style={[styles.thumb, { backgroundColor: colors.secondary, opacity: dimmed ? 0.6 : 1 }]}>
      <Image accessibilityLabel={file.name} source={{ uri: file.uri }} style={styles.thumbImage} contentFit="cover" />
      {onRemove && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} hitSlop={6} onPress={onRemove} style={styles.thumbRemove}>
          <CloseIcon size={10} color="#fff" />
        </Pressable>
      )}
      {progress !== undefined && (
        <View style={[styles.track, { backgroundColor: colors.controlTrack }]}>
          <View style={[styles.bar, { width: `${Math.round(progress * 100)}%`, backgroundColor: colors.blue }]} />
        </View>
      )}
    </View>
  )
}

/** Picked files as they show: photos as thumbnails, other files as chips. */
export function PickedFiles({ files, onRemove, progress, dimmed }: { files: readonly PickedFile[]; onRemove?: (file: PickedFile) => void; progress?: number; dimmed?: boolean }) {
  return (
    <>
      {files.map((file, index) =>
        attachmentKind(file) === 'image' ? (
          <PickedThumb key={`${file.uri}:${index}`} file={file} onRemove={onRemove && (() => onRemove(file))} progress={progress} dimmed={dimmed} />
        ) : (
          <FileChip key={`${file.uri}:${index}`} file={file} onRemove={onRemove && (() => onRemove(file))} progress={progress} dimmed={dimmed} />
        ),
      )}
    </>
  )
}

/**
 * Writes to the chat: + (Photo Library, Take Photo, Choose File), the field, the mic (Dictation), Send. The chat's unsent text is the live
 * store's draft, kept on the phone, so leaving the chat or restarting the app doesn't lose it. In a DM, a message sent
 * while the bot works supersedes its run, as on the web. Offline, the owner can keep writing but not send.
 */
export function Composer({
  chatId,
  label,
  files,
  notice,
  canSend,
  onAttach,
  onRemove,
  onSend,
  draft,
}: {
  chatId: string
  label: string
  files: PickedFile[]
  notice: string | undefined
  /** Whether the instance can be reached; there is no queue of messages to send later. */
  canSend: boolean
  /** Without it there is no +: the new group chat's first message takes no files. */
  onAttach?: (files: PickedFile[]) => void
  onRemove: (file: PickedFile) => void
  onSend: (text: string) => void
  /** The text held elsewhere instead of the chat's draft, for a chat that doesn't exist yet. */
  draft?: { text: string; onText: (text: string) => void }
}) {
  const live = useLive()
  const colors = useColors()
  const text = draft ? draft.text : (live.drafts.get(chatId) ?? '')
  const setText = (next: string) => (draft ? draft.onText(next) : live.setDraft(chatId, next))
  const [sheet, setSheet] = useState<SheetContent>()
  const room = maxAttachments - files.length

  // Dictation: what was said goes in at the cursor and the keyboard comes up to edit it; it's never sent by itself.
  const field = useRef<TextInputInstance>(null)
  const cursor = useRef<Selection>({ start: text.length, end: text.length })
  const [placed, setPlaced] = useState<Selection>()
  const [modelSheet, setModelSheet] = useState(false)
  // The field is back once dictation is over: the keyboard comes up on it to edit what was said.
  const focusField = useRef(false)
  const dictation = useDictation({
    onText: (spoken) => {
      // The draft as it is now: a transcription can land after leaving the chat.
      const current = draft ? draft.text : (live.drafts.get(chatId) ?? '')
      const { text: next, cursor: at } = insertDictation(current, cursor.current, spoken)
      setText(next)
      cursor.current = { start: at, end: at }
      setPlaced({ start: at, end: at })
      focusField.current = true
    },
    onNeedModel: () => setModelSheet(true),
  })
  useEffect(() => {
    if (dictation.phase.kind !== 'idle' || !focusField.current) return
    focusField.current = false
    // Once the field is laid out: Android doesn't raise the keyboard for a field focused as it mounts.
    const timer = setTimeout(() => field.current?.focus(), 150)
    return () => clearTimeout(timer)
  }, [dictation.phase.kind])

  const pick = (work: () => Promise<PickedFile[] | 'denied'>) => async () => {
    try {
      const picked = await work()
      if (picked === 'denied') {
        Alert.alert('Camera not allowed', 'Allow OpenBot to use the camera in Settings to take a photo.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ])
      } else if (picked.length) onAttach?.(picked)
    } catch (caught) {
      Alert.alert("Couldn't add that", errorMessage(caught))
    }
  }

  const send = () => {
    const trimmed = text.trim()
    if ((!trimmed && !files.length) || !canSend) return
    setText('')
    onSend(trimmed)
  }
  const sendable = canSend && (!!text.trim() || files.length > 0)

  return (
    <View style={styles.composer}>
      {dictation.toast && <DictationToastView toast={dictation.toast} onClose={dictation.dismissToast} />}
      {notice && <Text style={[styles.notice, { color: colors.mutedForeground }]}>{notice}</Text>}
      <View style={[styles.box, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
        {files.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.files} keyboardShouldPersistTaps="handled">
            <PickedFiles files={files} onRemove={onRemove} />
          </ScrollView>
        )}
        {dictation.phase.kind === 'listening' ? (
          <ListeningBar levels={dictation.levels} elapsedMs={dictation.elapsedMs} onCancel={dictation.cancel} onDone={() => void dictation.finish()} />
        ) : dictation.phase.kind === 'transcribing' ? (
          <TranscribingBar />
        ) : (
        <View style={styles.row}>
          {onAttach && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach"
            accessibilityState={{ disabled: room <= 0 }}
            disabled={room <= 0}
            onPress={() =>
              setSheet({
                items: [
                  { label: 'Photo Library', run: () => void pick(() => pickFromLibrary(room))() },
                  { label: 'Take Photo', run: () => void pick(takePhoto)() },
                  { label: 'Choose File', run: () => void pick(chooseFiles)() },
                ],
              })
            }
            style={({ pressed }) => [styles.round, { backgroundColor: colors.background, opacity: room <= 0 ? 0.4 : pressed ? 0.7 : 1 }]}
          >
            <PlusIcon size={18} color={colors.foreground} />
          </Pressable>
          )}
          <TextInput
            accessibilityLabel={label}
            placeholder={label}
            placeholderTextColor={colors.faint}
            multiline
            value={text}
            onChangeText={setText}
            ref={field}
            selection={placed}
            onSelectionChange={({ nativeEvent }) => {
              cursor.current = nativeEvent.selection
              if (placed) setPlaced(undefined)
            }}
            style={[styles.field, { color: colors.foreground }]}
          />
          <MicButton onPress={() => void dictation.start()} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !sendable }}
            disabled={!sendable}
            onPress={send}
            style={({ pressed }) => [styles.round, { backgroundColor: colors.primary, opacity: !sendable ? 0.35 : pressed ? 0.7 : 1 }]}
          >
            <SendIcon color={colors.primaryForeground} />
          </Pressable>
        </View>
        )}
      </View>
      <ActionSheet sheet={sheet} onClose={() => setSheet(undefined)} />
      <ModelSheet visible={modelSheet} onClose={() => setModelSheet(false)} />
    </View>
  )
}

const styles = StyleSheet.create({
  composer: { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 8 },
  notice: { fontSize: 12, paddingHorizontal: 6, paddingBottom: 4 },
  box: { borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: 6, gap: 6 },
  files: { gap: 6, paddingHorizontal: 2, paddingTop: 2, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  round: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 140, minHeight: 34, paddingTop: 7, paddingBottom: 6, paddingHorizontal: 4 },
  thumb: { width: 56, height: 56, borderRadius: 10, overflow: 'hidden' },
  thumbImage: { flex: 1 },
  thumbRemove: { position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: 9, backgroundColor: '#000000a0', alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  bar: { height: 3 },
})
