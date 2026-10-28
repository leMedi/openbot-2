import { type BotInfo, type FactChanges, type FactInfo, type FactTier, type NewFact } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { inputClass } from './bot-fields.tsx'

const tierSections: { tier: FactTier; title: string; hint: string }[] = [
  { tier: 'profile', title: 'Profile', hint: 'Always relevant; never fades.' },
  { tier: 'log', title: 'Log', hint: 'Dated events; they fade but are kept.' },
  { tier: 'note', title: 'Notes', hint: 'Short-lived; out of prompts after a week.' },
]

const importances = [1, 2, 3, 4, 5] as const

/** How the owner changes the facts listed: in a bot's bot memory, or in shared memory. */
export type FactActions = {
  add: (fact: NewFact) => Promise<FactInfo>
  edit: (id: number, changes: FactChanges) => Promise<FactInfo>
  remove: (id: number) => Promise<void>
}

/**
 * Facts by tier, each with its source, importance and the day it was learned, which the owner adds, edits and deletes
 * like Grok Bot's forms: there is no Save button. Text saves when the field loses focus; tier and importance at once.
 * Bots see the owner's changes on their next run. `onChange` gets how each saved change changes the facts.
 */
export function FactsByTier({
  facts,
  actions,
  onChange,
}: {
  facts: FactInfo[]
  actions: FactActions
  onChange: (change: (facts: FactInfo[]) => FactInfo[]) => void
}) {
  const [adding, setAdding] = useState<FactTier>()

  return tierSections.map(({ tier, title, hint }) => {
    const inTier = facts.filter((fact) => fact.tier === tier)
    return (
      <section key={tier} aria-label={title} className="flex flex-col gap-2">
        <header className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-medium">{title}</h3>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
          <button type="button" onClick={() => setAdding(tier)} className="shrink-0 rounded-md px-2 py-1 text-sm text-link hover:bg-secondary">
            Add
          </button>
        </header>
        <ul className="flex flex-col gap-2">
          {inTier.map((fact) => (
            <FactRow
              key={fact.id}
              fact={fact}
              actions={actions}
              onSaved={(saved) => onChange((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)))}
              onDeleted={() => onChange((current) => current.filter((entry) => entry.id !== fact.id))}
            />
          ))}
          {adding === tier && (
            <NewFactRow
              tier={tier}
              actions={actions}
              onAdded={(added) => {
                // The owner may have moved on to add to another tier meanwhile.
                setAdding((current) => (current === tier ? undefined : current))
                onChange((current) => [...current, added])
              }}
              onCancel={() => setAdding((current) => (current === tier ? undefined : current))}
            />
          )}
        </ul>
      </section>
    )
  })
}

type SaveStatus = { saving: boolean; error?: string }

/** "Saving…" while a change is on its way, or why it failed, prefixed with `failed`; nothing otherwise. */
function SaveStatusLine({ status, failed }: { status: SaveStatus; failed: string }) {
  if (!status.saving && !status.error) return null
  return (
    <p role="status" className={cn('text-xs', status.error ? 'text-destructive-foreground' : 'text-muted-foreground')}>
      {status.error ? `${failed}: ${status.error}` : 'Saving…'}
    </p>
  )
}

/**
 * One fact: its text saves on blur (an emptied text puts the old one back), its tier and importance at once. Its changes
 * are sent one after another, so they land in the order the owner made them.
 */
function FactRow({ fact, actions, onSaved, onDeleted }: { fact: FactInfo; actions: FactActions; onSaved: (fact: FactInfo) => void; onDeleted: () => void }) {
  const [text, setText] = useState(fact.content)
  const [status, setStatus] = useState<SaveStatus>({ saving: false })
  const editing = useRef(false)
  const queue = useRef(Promise.resolve())

  // Changed elsewhere, e.g. by the bot: show it as it is, unless the owner is typing. A failed save keeps their text.
  useEffect(() => {
    if (!editing.current) setText(fact.content)
  }, [fact.content])

  function run(work: () => Promise<void>) {
    setStatus({ saving: true })
    queue.current = queue.current.then(async () => {
      try {
        await work()
        setStatus({ saving: false })
      } catch (caught) {
        setStatus({ saving: false, error: errorMessage(caught) })
      }
    })
  }

  const save = (changes: FactChanges) => run(async () => onSaved(await actions.edit(fact.id, changes)))

  function blur() {
    editing.current = false
    const trimmed = text.trim()
    if (!trimmed) return setText(fact.content)
    if (trimmed !== fact.content) save({ text: trimmed })
  }

  return (
    <li className="flex flex-col gap-1.5 rounded-md bg-secondary px-3 py-2">
      <textarea
        aria-label="Fact"
        rows={2}
        value={text}
        onFocus={() => (editing.current = true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={blur}
        className="resize-y bg-transparent text-base break-words outline-offset-2"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Learned {new Date(fact.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}{' '}
          {fact.source === 'owner' ? 'from you' : `via ${fact.sourceBotName ?? 'a deleted bot'}`}
        </span>
        <TierSelect value={fact.tier} onChange={(tier) => save({ tier })} />
        <ImportanceSelect value={fact.importance} onChange={(importance) => save({ importance })} />
        <button
          type="button"
          onClick={() =>
            run(async () => {
              await actions.remove(fact.id)
              onDeleted()
            })
          }
          className="ml-auto rounded-md px-1.5 py-0.5 text-destructive-foreground hover:bg-secondary-hover"
        >
          Delete
        </button>
      </div>
      <SaveStatusLine status={status} failed="Couldn't save" />
    </li>
  )
}

/** A fact the owner is adding to `tier`, with importance 3 unless changed: saved once its text loses focus, dropped if empty. */
function NewFactRow({ tier, actions, onAdded, onCancel }: { tier: FactTier; actions: FactActions; onAdded: (fact: FactInfo) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  const [importance, setImportance] = useState(3)
  const [status, setStatus] = useState<SaveStatus>({ saving: false })

  async function add() {
    if (status.saving) return
    if (!text.trim()) return onCancel()
    setStatus({ saving: true })
    try {
      onAdded(await actions.add({ tier, text, importance }))
    } catch (caught) {
      setStatus({ saving: false, error: errorMessage(caught) })
    }
  }

  return (
    <li
      className="flex flex-col gap-1.5 rounded-md bg-secondary px-3 py-2"
      onBlur={(event) => {
        // Moving between its text and importance isn't leaving the new fact.
        if (!event.currentTarget.contains(event.relatedTarget)) void add()
      }}
    >
      <textarea
        aria-label="New fact"
        autoFocus
        rows={2}
        placeholder="Something your bots should remember"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        className={cn(inputClass, 'resize-y')}
      />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ImportanceSelect value={importance} onChange={setImportance} />
      </div>
      <SaveStatusLine status={status} failed="Couldn't add" />
    </li>
  )
}

function TierSelect({ value, onChange }: { value: FactTier; onChange: (tier: FactTier) => void }) {
  return (
    <select aria-label="Tier" value={value} onChange={(event) => onChange(event.target.value as FactTier)} className="rounded bg-transparent">
      {tierSections.map(({ tier, title }) => (
        <option key={tier} value={tier}>
          {title}
        </option>
      ))}
    </select>
  )
}

function ImportanceSelect({ value, onChange }: { value: number; onChange: (importance: number) => void }) {
  return (
    <select aria-label="Importance" value={value} onChange={(event) => onChange(Number(event.target.value))} className="rounded bg-transparent">
      {importances.map((importance) => (
        <option key={importance} value={importance}>
          Importance {importance}
        </option>
      ))}
    </select>
  )
}

/**
 * A bot's bot memory: its facts by tier, each with its source, importance and the day it was learned, which the owner
 * adds, edits and deletes. It lists every fact, also those its prompt leaves out. Read again whenever the bot finishes
 * working, which may have changed it.
 */
export function MemoryPane({ bot }: { bot: BotInfo }) {
  const [facts, setFacts] = useState<{ botId: string; facts: FactInfo[] }>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (bot.working) return
    let current = true
    api()
      .bots.memory({ botId: bot.id })
      .then((loaded) => {
        if (!current) return
        setFacts({ botId: bot.id, facts: loaded })
        setError(undefined)
      })
      .catch((caught) => current && setError(errorMessage(caught)))
    return () => {
      current = false
    }
  }, [bot.id, bot.working])
  const shown = facts?.botId === bot.id ? facts.facts : undefined
  const botId = bot.id
  const actions: FactActions = {
    add: (fact) => api().bots.addFact({ botId, ...fact }),
    edit: (factId, changes) => api().bots.editFact({ botId, factId, ...changes }),
    remove: (factId) => api().bots.deleteFact({ botId, factId }),
  }

  return (
    <aside aria-label={`${bot.name}'s memory`} className="flex w-[360px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle p-5">
      <h2 className="text-lg font-semibold">Memory</h2>
      {error && <p className="text-sm text-destructive-foreground">Couldn't load {bot.name}'s memory: {error}</p>}
      {shown && !shown.length && <p className="text-sm text-muted-foreground">{bot.name} doesn't remember anything yet.</p>}
      {shown && (
        <FactsByTier
          facts={shown}
          actions={actions}
          // A change saved after the owner moved to another bot is that bot's; its list is read anew.
          onChange={(change) => setFacts((current) => (current?.botId === botId ? { botId, facts: change(current.facts) } : current))}
        />
      )}
    </aside>
  )
}
