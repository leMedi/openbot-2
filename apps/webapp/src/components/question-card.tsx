import type { MessageInfo, QuestionAnswer, QuestionCardInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { Markdown } from './markdown.tsx'

const letter = (index: number) => String.fromCharCode(65 + index)

/** Whether a key press belongs to something else: a field being typed in, an open dialog, or a shortcut. */
function keyIsTaken(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.isComposing) return true
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return true
  return document.querySelector('dialog[open]') !== null
}

/**
 * A bot's question: its prompt, 1–6 lettered options and, when allowed, a free-text answer. With `letterKeys`
 * (the chat's newest open question), pressing an option's letter answers it. Its × dismisses it unanswered without
 * waking the bot. Once answered or dismissed it can't be answered again.
 */
export function QuestionCard({
  message,
  card,
  letterKeys,
  onAnswered,
}: {
  message: MessageInfo
  card: QuestionCardInfo
  letterKeys: boolean
  onAnswered: (message: MessageInfo) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const answerRef = useRef<(answer: QuestionAnswer) => void>(undefined)

  /** Sends the owner's answer or dismissal, once at a time, and shows the card as the server now has it. */
  async function close(request: () => Promise<MessageInfo>) {
    if (sending || card.answer || card.dismissed) return
    setSending(true)
    setError(undefined)
    try {
      onAnswered(await request())
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSending(false)
    }
  }
  const answer = (chosen: QuestionAnswer) => close(() => api().chats.answer({ messageId: message.id, answer: chosen }))
  const dismiss = () => close(() => api().chats.dismiss({ messageId: message.id }))
  answerRef.current = (chosen) => void answer(chosen)

  useEffect(() => {
    if (!letterKeys || card.answer || card.dismissed) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyIsTaken(event) || event.key.length !== 1) return
      const index = event.key.toUpperCase().charCodeAt(0) - 65
      if (index < 0 || index >= card.options.length) return
      event.preventDefault()
      answerRef.current?.({ option: index })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [letterKeys, card.answer, card.dismissed, card.options.length])

  if (card.dismissed) {
    return (
      <section aria-label="Dismissed question" className="w-full rounded-2xl bg-bubble-agent p-3 text-base/5 text-muted-foreground">
        <p className="[overflow-wrap:anywhere]">{card.prompt}</p>
        <p className="mt-1 text-sm">Dismissed</p>
      </section>
    )
  }

  if (card.answer) {
    const shown = 'option' in card.answer ? `${letter(card.answer.option)}. ${card.options[card.answer.option]?.label}` : card.answer.text
    return (
      <section aria-label="Answered question" className="w-full rounded-2xl bg-bubble-agent p-3 text-base/5">
        <p className="text-muted-foreground">{card.prompt}</p>
        <p className="mt-1 flex items-start gap-2 font-medium">
          <span aria-hidden className="text-green-foreground">
            ✓
          </span>
          <span className="sr-only">Answered: </span>
          <span className="[overflow-wrap:anywhere]">{shown}</span>
        </p>
      </section>
    )
  }

  return (
    <section aria-label="Question" className="w-full rounded-2xl border border-border bg-bubble-agent p-3 text-base/5">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-semibold [overflow-wrap:anywhere]">{card.prompt}</p>
        <button
          type="button"
          aria-label="Dismiss question"
          title="Dismiss"
          disabled={sending}
          onClick={() => void dismiss()}
          className="pressable -mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-100 hover:bg-secondary-hover hover:text-foreground disabled:opacity-60"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      {card.details && (
        <div className="mt-1 text-sm text-muted-foreground">
          <Markdown text={card.details} />
        </div>
      )}
      <div className="mt-3 flex flex-col gap-1.5">
        {card.options.map((option, index) => (
          <button
            key={index}
            type="button"
            disabled={sending}
            onClick={() => void answer({ option: index })}
            aria-keyshortcuts={letterKeys ? letter(index) : undefined}
            className={cn(
              'pressable flex items-start gap-2.5 rounded-xl px-3 py-2 text-left transition-colors duration-100 disabled:opacity-60',
              option.style === 'primary' && 'bg-primary text-primary-foreground hover:bg-primary-hover',
              option.style === 'danger' && 'bg-red/10 text-red-foreground hover:bg-red/15',
              option.style === 'default' && 'bg-secondary hover:bg-secondary-hover',
            )}
          >
            <kbd
              aria-hidden
              className="mt-px grid size-5 shrink-0 place-items-center rounded-md border border-current/25 font-sans text-xs font-medium opacity-80"
            >
              {letter(index)}
            </kbd>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="block font-medium">{option.label}</span>
              {option.description && <span className="block text-sm opacity-75">{option.description}</span>}
            </span>
          </button>
        ))}
      </div>
      {card.allowText && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim()) void answer({ text: text.trim() })
          }}
          className="mt-2 flex items-end gap-2"
        >
          <textarea
            aria-label="Type your own answer"
            placeholder="Type your own answer"
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            className="max-h-40 min-h-9 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 outline-none [field-sizing:content] focus:border-border-strong"
          />
          {text.trim() && (
            <button
              type="submit"
              disabled={sending}
              className="pressable rounded-xl bg-primary px-3 py-2 font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60 motion-safe:animate-pop-in motion-reduce:animate-fade-in"
            >
              Submit
            </button>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </section>
  )
}
