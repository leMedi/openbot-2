import type { BotInfo, MessageInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../../components/bot-avatar.tsx'
import { Markdown } from '../../components/markdown.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { useLive } from '../../lib/live.tsx'

export const Route = createFileRoute('/_app/bots/$botId')({
  component: Dm,
})

/** The DM between the owner and one bot, in Grok Bot's layout. */
function Dm() {
  const { botId } = Route.useParams()
  const live = useLive()
  const bot = live.bots?.find((entry) => entry.id === botId)
  const [error, setError] = useState<string>()
  const [loadedChat, setLoadedChat] = useState<string>()

  const chatId = bot?.chatId
  useEffect(() => {
    if (!chatId) return
    setError(undefined)
    live.openChat(chatId).then(
      () => setLoadedChat(chatId),
      (caught) => setError(errorMessage(caught)),
    )
  }, [chatId, live])

  if (!bot) return live.bots ? <p className="m-auto text-muted-foreground">This bot doesn't exist.</p> : null
  const messages = live.messages.get(bot.chatId)
  const loading = loadedChat !== bot.chatId && !error

  return (
    <>
      <header className="flex min-h-[51px] items-center gap-2 border-b border-border-subtle px-4">
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} />
        <span className="font-semibold">{bot.name}</span>
        {bot.working && <span className="text-sm text-muted-foreground">Working</span>}
      </header>
      <MessageList bot={bot} messages={messages ?? []} loading={loading} />
      {error && <p className="px-6 text-destructive-foreground">{error}</p>}
      <Composer bot={bot} onSent={(message) => live.addMessage(message)} />
    </>
  )
}

function MessageList({ bot, messages, loading }: { bot: BotInfo; messages: MessageInfo[]; loading: boolean }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, bot.working])

  return (
    <div className="flex-1 overflow-y-auto px-[max(30px,calc((100%-690px)/2))] py-7">
      {loading && <p className="text-center text-muted-foreground">Loading…</p>}
      {!loading && messages.length === 0 && <p className="text-center text-muted-foreground">Say hi to {bot.name}.</p>}
      {messages.map((message, index) => {
        const mine = message.author === 'owner'
        // Consecutive messages of one author sit close together.
        const groupEnd = messages[index + 1]?.author !== message.author
        return (
          <div key={message.id} role="article" className={cn('flex', mine && 'justify-end', groupEnd ? 'mb-[22px]' : 'mb-1')}>
            <span className="sr-only">{message.authorName}: </span>
            <div
              className={cn(
                'max-w-[min(88%,640px)] rounded-[18px] px-3 py-2 text-base/5 [overflow-wrap:anywhere]',
                mine ? 'bg-bubble-user text-on-color' : 'bg-bubble-agent',
              )}
            >
              {mine ? <p className="whitespace-pre-wrap">{message.text}</p> : <Markdown text={message.text} />}
            </div>
          </div>
        )
      })}
      {bot.working && (
        <div aria-label={`${bot.name} is working`} className="mb-[22px] inline-flex gap-1 rounded-[14px] bg-bubble-agent px-3 py-2.5">
          {[0, 1, 2].map((dot) => (
            <span key={dot} className="size-[5px] animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${dot * 150}ms` }} />
          ))}
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

function Composer({ bot, onSent }: { bot: BotInfo; onSent: (message: MessageInfo) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()

  async function send() {
    const draft = text.trim()
    if (!draft) return
    setText('')
    setError(undefined)
    try {
      onSent(await api().chats.send({ chatId: bot.chatId, text: draft }))
    } catch (caught) {
      setText(draft)
      setError(errorMessage(caught))
    }
  }

  return (
    <div className="px-[max(24px,calc((100%-700px)/2))] pt-2 pb-[18px]">
      {error && <p className="pb-1 text-sm text-destructive-foreground">{error}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
        className="flex items-end gap-2 rounded-2xl border border-border bg-secondary p-[9px] shadow-sm"
      >
        <textarea
          aria-label={`Message ${bot.name}`}
          placeholder={`Message ${bot.name}`}
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          className="max-h-60 min-h-12 flex-1 resize-none bg-transparent px-1 leading-[1.4] outline-none"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!text.trim()}
          className="grid size-[30px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
        >
          ↑
        </button>
      </form>
    </div>
  )
}
