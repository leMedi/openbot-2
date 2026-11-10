import { Linking } from 'react-native'

/** Opens `path` of the instance at `url` in the browser, for what stays on the web (e.g. signing in to a provider). */
export function openOnWeb(url: string, path: string) {
  void Linking.openURL(new URL(path, url).href)
}
