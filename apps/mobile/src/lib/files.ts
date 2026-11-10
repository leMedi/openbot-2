import { type AttachmentInfo, attachmentPath } from '@openbot/api-contract'
import * as DocumentPicker from 'expo-document-picker'
import { Directory, File, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import * as Sharing from 'expo-sharing'
import type { PickedFile } from './upload.ts'

/** Where a message's file downloads from, on the instance at `url`. */
export const attachmentUri = (url: string, messageId: string, attachment: AttachmentInfo) => new URL(`/api${attachmentPath(messageId, attachment.id)}`, url).href

/**
 * Downloads a message's file into the app's cache (once; a later tap reuses it) and offers it to the phone's share
 * sheet, from which the owner opens it in another app or saves it to Files.
 */
export async function openAttachment(url: string, messageId: string, attachment: AttachmentInfo) {
  const folder = new Directory(Paths.cache, 'attachments', messageId, attachment.id)
  folder.create({ intermediates: true, idempotent: true })
  const file = new File(folder, attachment.name)
  if (!file.exists) await File.downloadFileAsync(attachmentUri(url, messageId, attachment), file)
  await Sharing.shareAsync(file.uri, { mimeType: attachment.mimeType, dialogTitle: attachment.name })
}

const extensionTypes: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime' }

/** A size the picker didn't give, read from disk; 0 if it can't be. */
function sizeOnDisk(uri: string): number {
  try {
    return new File(uri).size ?? 0
  } catch {
    return 0
  }
}

function fromImagePicker(result: ImagePicker.ImagePickerResult): PickedFile[] {
  if (result.canceled) return []
  return result.assets.map((asset, index) => {
    const name = asset.fileName || asset.uri.split('/').pop() || `${asset.type === 'video' ? 'video' : 'photo'}-${Date.now()}-${index}.jpg`
    const extension = name.split('.').pop()?.toLowerCase() ?? ''
    return {
      uri: asset.uri,
      name,
      size: asset.fileSize ?? sizeOnDisk(asset.uri),
      mimeType: asset.mimeType || extensionTypes[extension] || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
    }
  })
}

/** Photos and videos from the library, up to `limit`; none if the owner cancels. */
export async function pickFromLibrary(limit: number): Promise<PickedFile[]> {
  return fromImagePicker(
    await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: limit, quality: 1 }),
  )
}

/** A photo from the camera, asking for it first; why not when it's refused. */
export async function takePhoto(): Promise<PickedFile[] | 'denied'> {
  const permission = await ImagePicker.requestCameraPermissionsAsync()
  if (!permission.granted) return 'denied'
  return fromImagePicker(await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 }))
}

/** Any files, from Files on iOS or the document picker on Android; copied into the cache so they can be sent. */
export async function chooseFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
  if (result.canceled) return []
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    size: asset.size ?? sizeOnDisk(asset.uri),
    mimeType: asset.mimeType || 'application/octet-stream',
  }))
}
