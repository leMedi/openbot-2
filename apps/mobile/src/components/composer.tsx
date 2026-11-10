import { maxAttachments } from '@openbot/api-contract'
import { attachmentKind, useLive } from '@openbot/client'
import { Image } from 'expo-image'
import { useState } from 'react'
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { errorMessage } from '../lib/errors.ts'
import { chooseFiles, pickFromLibrary, takePhoto } from '../lib/files.ts'
import { useColors } from '../lib/theme.ts'
import type { PickedFile } from '../lib/upload.ts'
import { ActionSheet, type SheetContent } from './action-sheet.tsx'
import { FileChip } from './attachments.tsx'
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
 * Writes to the chat: + (Photo Library, Take Photo, Choose File), the field, Send. The chat's unsent text is the live
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
}: {
  chatId: string
  label: string
  files: PickedFile[]
  notice: string | undefined
  /** Whether the instance can be reached; there is no queue of messages to send later. */
  canSend: boolean
  onAttach: (files: PickedFile[]) => void
  onRemove: (file: PickedFile) => void
  onSend: (text: string) => void
}) {
  const live = useLive()
  const colors = useColors()
  const text = live.drafts.get(chatId) ?? ''
  const [sheet, setSheet] = useState<SheetContent>()
  const room = maxAttachments - files.length

  const pick = (work: () => Promise<PickedFile[] | 'denied'>) => async () => {
    try {
      const picked = await work()
      if (picked === 'denied') {
        Alert.alert('Camera not allowed', 'Allow OpenBot to use the camera in Settings to take a photo.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ])
      } else if (picked.length) onAttach(picked)
    } catch (caught) {
      Alert.alert("Couldn't add that", errorMessage(caught))
    }
  }

  const send = () => {
    const draft = text.trim()
    if ((!draft && !files.length) || !canSend) return
    live.setDraft(chatId, '')
    onSend(draft)
  }
  const sendable = canSend && (!!text.trim() || files.length > 0)

  return (
    <View style={styles.composer}>
      {notice && <Text style={[styles.notice, { color: colors.mutedForeground }]}>{notice}</Text>}
      <View style={[styles.box, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
        {files.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.files} keyboardShouldPersistTaps="handled">
            <PickedFiles files={files} onRemove={onRemove} />
          </ScrollView>
        )}
        <View style={styles.row}>
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
          <TextInput
            accessibilityLabel={label}
            placeholder={label}
            placeholderTextColor={colors.faint}
            multiline
            value={text}
            onChangeText={(next) => live.setDraft(chatId, next)}
            style={[styles.field, { color: colors.foreground }]}
          />
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
      </View>
      <ActionSheet sheet={sheet} onClose={() => setSheet(undefined)} />
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
