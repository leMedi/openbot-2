import { type MessageInfo, previewText } from '@openbot/api-contract'
import { chatName, summarizeAttachments, useLive } from '@openbot/client'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native'
import { useColors } from '../../lib/theme.ts'

/**
 * A chat, opened from the Chats list or a search hit (at `message`): a first cut, read-only, that the Chat screen's
 * own work replaces with the transcript, cards and the composer. It loads the latest messages (and older ones until
 * the hit's message is among them), scrolls to the hit and marks the chat read.
 */
export default function Chat() {
  const { chatId, message } = useLocalSearchParams<{ chatId: string; message?: string }>()
  const live = useLive()
  const colors = useColors()
  const chat = live.chats.get(chatId)
  const messages = live.messages.get(chatId)
  const [loaded, setLoaded] = useState(false)
  const list = useRef<FlatList<MessageInfo>>(null)

  useEffect(() => {
    let current = true
    void (async () => {
      await live.openChat(chatId)
      if (message) await live.loadUntil(chatId, message)
      if (!current) return
      setLoaded(true)
      void live.markRead(chatId, undefined).catch(() => {})
    })().catch(() => current && setLoaded(true))
    return () => {
      current = false
    }
  }, [live, chatId, message])

  // Newest at the bottom; the list is inverted, so index 0 is the newest.
  const newestFirst = [...(messages ?? [])].reverse()
  const target = message ? newestFirst.findIndex((entry) => entry.id === message) : -1
  // Scrolled to the hit once: messages arriving later shift its index, and mustn't scroll back to it.
  const scrolledTo = useRef<string>(undefined)
  useEffect(() => {
    if (!loaded || target < 0 || scrolledTo.current === message) return
    scrolledTo.current = message
    const timer = setTimeout(() => list.current?.scrollToIndex({ index: target, viewPosition: 0.5, animated: false }), 50)
    return () => clearTimeout(timer)
  }, [loaded, target, message])
  // A hit beyond what's laid out yet is tried once more, once the list has measured further.
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(retry.current), [])

  return (
    <>
      <Stack.Screen options={{ title: chat ? chatName(live.bots, chat) : '', headerBackTitle: 'Chats', headerLargeTitle: false }} />
      {!loaded ? (
        <ActivityIndicator style={styles.loading} color={colors.mutedForeground} />
      ) : (
        <FlatList
          ref={list}
          inverted
          data={newestFirst}
          keyExtractor={(entry) => entry.id}
          style={{ backgroundColor: colors.background }}
          contentContainerStyle={styles.content}
          onScrollToIndexFailed={({ index }) => {
            if (retry.current) return
            retry.current = setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false }), 200)
          }}
          renderItem={({ item }) => {
            const mine = item.author === 'owner'
            const text = previewText(item.text) || (item.attachments.length ? summarizeAttachments(item.attachments) : item.card ? 'Card' : '')
            return (
              <View
                style={[
                  styles.bubble,
                  mine ? styles.mine : styles.theirs,
                  { backgroundColor: mine ? colors.bubbleUser : colors.bubbleAgent },
                  item.id === message && { borderWidth: 2, borderColor: colors.blue },
                ]}
              >
                {!mine && chat?.kind === 'group' && <Text style={[styles.author, { color: colors.mutedForeground }]}>{item.authorName}</Text>}
                <Text style={[styles.text, { color: mine ? colors.onColor : colors.foreground }]}>{text}</Text>
              </View>
            )
          }}
        />
      )}
    </>
  )
}

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  content: { padding: 14, gap: 8 },
  bubble: { maxWidth: '80%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18 },
  mine: { alignSelf: 'flex-end' },
  theirs: { alignSelf: 'flex-start' },
  author: { fontSize: 12, fontWeight: '600', marginBottom: 2 },
  text: { fontSize: 15, lineHeight: 21 },
})
