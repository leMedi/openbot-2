import type { AttachmentInfo } from '@openbot/api-contract'
import { attachmentKind, type ComposerFile, formatSize } from '@openbot/client'
import { Image } from 'expo-image'
import { useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { errorMessage } from '../lib/errors.ts'
import { attachmentUri, openAttachment } from '../lib/files.ts'
import { useInstance } from '../lib/instance-context.ts'
import { useColors } from '../lib/theme.ts'
import { CloseIcon, FileIcon, PlayIcon } from './icons.tsx'

/** The widest and tallest a picture in the transcript gets (the web's gallery is 320px high at most). */
const maxThumb = { width: 240, height: 280 }

/**
 * A message's files in Grok's transcript styles: pictures in a gallery that opens the full-screen viewer; videos, audio
 * and every other file as chips that download and open in another app through the share sheet.
 */
export function Attachments({ messageId, attachments, mine }: { messageId: string; attachments: AttachmentInfo[]; mine: boolean }) {
  const [viewing, setViewing] = useState<number>()
  const images = attachments.filter((file) => attachmentKind(file) === 'image')
  const others = attachments.filter((file) => attachmentKind(file) !== 'image')
  return (
    <>
      {images.length > 0 && (
        <View style={[styles.wrap, mine && styles.end]}>
          {images.map((file, index) => (
            <Thumb key={file.id} messageId={messageId} file={file} onPress={() => setViewing(index)} />
          ))}
        </View>
      )}
      {others.length > 0 && (
        <View style={[styles.wrap, mine && styles.end]}>
          {others.map((file) => (
            <AttachmentChip key={file.id} messageId={messageId} file={file} />
          ))}
        </View>
      )}
      {viewing !== undefined && <Viewer messageId={messageId} images={images} index={viewing} onClose={() => setViewing(undefined)} />}
    </>
  )
}

/** A picture at its own proportions, within the transcript's bounds, once it's loaded. */
function Thumb({ messageId, file, onPress }: { messageId: string; file: AttachmentInfo; onPress: () => void }) {
  const { url } = useInstance()
  const colors = useColors()
  const [ratio, setRatio] = useState(4 / 3)
  const width = Math.min(maxThumb.width, maxThumb.height * ratio)
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={`View ${file.name}`} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
      <Image
        source={{ uri: attachmentUri(url, messageId, file) }}
        style={[styles.thumb, { width, height: width / ratio, backgroundColor: colors.secondary }]}
        contentFit="cover"
        transition={120}
        onLoad={(event) => event.source.width && event.source.height && setRatio(event.source.width / event.source.height)}
      />
    </Pressable>
  )
}

/** A file to open: its kind's icon, name and size; a tap downloads it (once) and opens the share sheet. */
function AttachmentChip({ messageId, file }: { messageId: string; file: AttachmentInfo }) {
  const { url } = useInstance()
  const colors = useColors()
  const [opening, setOpening] = useState(false)
  const kind = attachmentKind(file)
  const open = async () => {
    setOpening(true)
    try {
      await openAttachment(url, messageId, file)
    } catch (caught) {
      Alert.alert(`Couldn't open ${file.name}`, errorMessage(caught))
    } finally {
      setOpening(false)
    }
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${file.name}, ${formatSize(file.size)}`}
      disabled={opening}
      onPress={() => void open()}
      style={({ pressed }) => [styles.chip, styles.attachmentChip, { borderColor: colors.border, backgroundColor: pressed ? colors.muted : colors.card }]}
    >
      {opening ? (
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      ) : kind === 'video' || kind === 'audio' ? (
        <PlayIcon color={colors.mutedForeground} />
      ) : (
        <FileIcon color={colors.mutedForeground} />
      )}
      <View style={styles.chipText}>
        <Text numberOfLines={1} style={[styles.chipName, { color: colors.foreground }]}>
          {file.name}
        </Text>
        <Text style={[styles.chipSize, { color: colors.mutedForeground }]}>{formatSize(file.size)}</Text>
      </View>
    </Pressable>
  )
}

/**
 * A file in the composer or going out with a message: Grok's chip with its name and size, a × to remove it from the
 * composer, and while it uploads, how far along it is.
 */
export function FileChip({ file, onRemove, progress, dimmed = false }: { file: ComposerFile; onRemove?: () => void; progress?: number; dimmed?: boolean }) {
  const colors = useColors()
  return (
    <View style={[styles.chip, styles.fileChip, { borderColor: colors.border, backgroundColor: colors.card, opacity: dimmed ? 0.6 : 1 }]}>
      <FileIcon size={16} color={colors.mutedForeground} />
      <View style={styles.chipText}>
        <Text numberOfLines={1} style={[styles.smallName, { color: colors.foreground }]}>
          {file.name}
        </Text>
        <Text style={[styles.smallSize, { color: colors.mutedForeground }]}>{formatSize(file.size)}</Text>
      </View>
      {onRemove && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} hitSlop={8} onPress={onRemove} style={styles.remove}>
          <CloseIcon size={12} color={colors.mutedForeground} />
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

/** Grok's full-screen viewer: a dark backdrop, swiping between a message's pictures, Share and ✕. */
function Viewer({ messageId, images, index, onClose }: { messageId: string; images: AttachmentInfo[]; index: number; onClose: () => void }) {
  const { url } = useInstance()
  const { width } = useWindowDimensions()
  const [shown, setShown] = useState(index)
  const [sharing, setSharing] = useState(false)
  const file = images[shown] ?? images[0]!
  const share = async () => {
    setSharing(true)
    try {
      await openAttachment(url, messageId, file)
    } catch (caught) {
      Alert.alert(`Couldn't share ${file.name}`, errorMessage(caught))
    } finally {
      setSharing(false)
    }
  }
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.viewer}>
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={index}
          getItemLayout={(_, item) => ({ length: width, offset: width * item, index: item })}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.id}
          onMomentumScrollEnd={(event) => setShown(Math.round(event.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <View style={{ width, flex: 1 }}>
              <Image accessibilityLabel={item.name} source={{ uri: attachmentUri(url, messageId, item) }} style={styles.full} contentFit="contain" />
            </View>
          )}
        />
        <SafeAreaView style={styles.viewerBar} edges={['top', 'left', 'right']}>
          <Text numberOfLines={1} style={styles.viewerName}>
            {file.name}
            {images.length > 1 ? `  ${shown + 1}/${images.length}` : ''}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => void share()} disabled={sharing} style={styles.viewerButton}>
            {sharing ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.viewerButtonText}>Share</Text>}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.viewerButton}>
            <CloseIcon size={16} color="#fff" />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, maxWidth: '100%' },
  end: { justifyContent: 'flex-end' },
  thumb: { borderRadius: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  attachmentChip: { gap: 8, paddingHorizontal: 10, paddingVertical: 8, maxWidth: 260, minHeight: 44 },
  chipText: { flexShrink: 1, minWidth: 0 },
  chipName: { fontSize: 14, fontWeight: '500' },
  chipSize: { fontSize: 12, fontVariant: ['tabular-nums'] },
  fileChip: { gap: 6, paddingLeft: 8, paddingRight: 6, paddingVertical: 6, maxWidth: 210 },
  smallName: { fontSize: 12, fontWeight: '500' },
  smallSize: { fontSize: 11, fontVariant: ['tabular-nums'] },
  remove: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3 },
  bar: { height: 3 },
  viewer: { flex: 1, backgroundColor: '#141414f2' },
  full: { flex: 1 },
  viewerBar: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#141414b3', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  viewerName: { flex: 1, color: '#fff', opacity: 0.85, fontSize: 14 },
  viewerButton: { minWidth: 40, height: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: '#ffffff26', alignItems: 'center', justifyContent: 'center' },
  viewerButtonText: { color: '#fff', fontSize: 15, fontWeight: '500' },
})
