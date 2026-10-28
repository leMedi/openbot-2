import type { ProviderInfo } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { Dialog } from './dialog.tsx'
import { ProviderLogo } from './provider-logo.tsx'
import { SignInWizard } from './sign-in-wizard.tsx'

type Method = ProviderInfo['methods'][number]

/** The providers most owners pick, in this order, with what each is for. */
const popular: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT and Codex',
  google: 'Gemini',
  openrouter: 'Hundreds of models, one key',
  'github-copilot': 'With your Copilot plan',
  xai: 'Grok',
  'vercel-ai-gateway': 'Many providers, one bill',
  deepseek: 'DeepSeek V3 and R1',
}
const popularOrder = Object.keys(popular)

/** Subscriptions first: signing in with a plan the owner already pays for beats creating a key. */
const byPreference = (a: Method, b: Method) => Number(b.subscription) - Number(a.subscription) || Number(a.method === 'api_key') - Number(b.method === 'api_key')

/**
 * Every provider, searchable: connected ones first, then the popular ones, then the rest by name. Choosing one connects
 * it (asking first how, when it can be connected more than one way) or, once connected, offers to disconnect it.
 * `onChange` follows each change.
 */
export function ProviderList({ onChange }: { onChange?: (providers: ProviderInfo[]) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [choosing, setChoosing] = useState<ProviderInfo>()
  const [signIn, setSignIn] = useState<{ provider: ProviderInfo; method: Method }>()
  const [managing, setManaging] = useState<ProviderInfo>()
  const list = useRef<HTMLDivElement>(null)

  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const load = useCallback(() => {
    api()
      .providers.list()
      .then(
        (providers) => {
          setProviders(providers)
          onChangeRef.current?.(providers)
        },
        (caught) => setError(errorMessage(caught)),
      )
  }, [])
  useEffect(load, [load])

  async function disconnect(provider: ProviderInfo) {
    try {
      await api().providers.disconnect({ providerId: provider.id })
      load()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const sections = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const shown = (providers ?? []).filter((provider) => {
      const text = `${provider.name} ${provider.id} ${popular[provider.id] ?? ''} ${provider.methods.map((method) => method.label).join(' ')}`.toLowerCase()
      return words.every((word) => text.includes(word))
    })
    const connected = shown.filter((provider) => provider.connection)
    const rest = shown.filter((provider) => !provider.connection)
    return [
      { title: 'Connected', providers: connected.sort((a, b) => a.name.localeCompare(b.name)) },
      {
        title: 'Popular',
        providers: rest.filter((provider) => provider.id in popular).sort((a, b) => popularOrder.indexOf(a.id) - popularOrder.indexOf(b.id)),
      },
      { title: 'Other', providers: rest.filter((provider) => !(provider.id in popular)).sort((a, b) => a.name.localeCompare(b.name)) },
    ].filter((section) => section.providers.length > 0)
  }, [providers, query])
  const rows = sections.flatMap((section) => section.providers)

  // A new search starts from its best match.
  useEffect(() => setActive(0), [query])

  function choose(provider: ProviderInfo) {
    if (provider.connection) return setManaging(provider)
    const methods = [...provider.methods].sort(byPreference)
    if (methods.length === 1) setSignIn({ provider, method: methods[0]! })
    else setChoosing(provider)
  }

  /** Moves the highlight by keyboard, keeping it in view; the pointer moves it too, without scrolling. */
  function move(by: number) {
    if (rows.length === 0) return
    const next = (active + by + rows.length) % rows.length
    setActive(next)
    list.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  let position = 0

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-destructive-foreground">{error}</p>}

      <div className="relative">
        <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground">
          <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          role="combobox"
          aria-expanded
          aria-controls="provider-options"
          aria-activedescendant={rows[active] ? `provider-${rows[active].id}` : undefined}
          aria-label="Search providers"
          placeholder="Search providers"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              move(event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (rows[active]) choose(rows[active])
            }
          }}
          className="w-full rounded-lg border border-input bg-input-fill py-2 pr-3 pl-8.5 text-lg outline-offset-0 placeholder:text-muted-foreground"
        />
      </div>

      <div
        ref={list}
        id="provider-options"
        role="listbox"
        aria-label="Providers"
        className="-mx-1 flex max-h-[min(440px,55vh)] flex-col gap-3 overflow-y-auto px-1 py-1"
      >
        {!providers && !error && <p className="px-2 py-1.5 text-muted-foreground">Loading…</p>}
        {providers && rows.length === 0 && <p className="px-2 py-1.5 text-muted-foreground">No provider matches “{query.trim()}”.</p>}
        {sections.map((section) => (
          <div key={section.title} role="group" aria-labelledby={`providers-${section.title}`} className="flex flex-col">
            <h3 id={`providers-${section.title}`} className="px-2 pb-1 text-sm font-medium text-muted-foreground">
              {section.title}
            </h3>
            {section.providers.map((provider) => {
              const row = position++
              return (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  row={row}
                  active={row === active}
                  onHover={() => setActive(row)}
                  onChoose={() => choose(provider)}
                />
              )
            })}
          </div>
        ))}
      </div>

      {choosing && (
        <MethodDialog
          provider={choosing}
          onClose={(method) => {
            setChoosing(undefined)
            if (method) setSignIn({ provider: choosing, method })
          }}
        />
      )}

      {managing && (
        <Dialog label={managing.name} onClose={() => setManaging(undefined)}>
          {(close) => (
            <>
              <header className="flex items-center gap-3">
                <ProviderLogo id={managing.id} name={managing.name} size={32} />
                <div className="flex flex-col">
                  <h2 className="text-lg font-semibold">{managing.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    Connected {managing.connection?.method === 'oauth' ? 'with your account' : 'with an API key'}
                  </p>
                </div>
              </header>
              <p className="text-muted-foreground">
                Disconnecting stops bots using its models until you connect it again.{' '}
                {managing.connection?.method === 'oauth' ? "You'll need to sign in again." : "You'll need to enter the API key again."}
              </p>
              <footer className="flex justify-end gap-2">
                <button type="button" data-autofocus onClick={close} className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
                  Keep connected
                </button>
                <button
                  type="button"
                  onClick={() => {
                    close()
                    void disconnect(managing)
                  }}
                  className="pressable rounded-md bg-destructive px-3 py-1.5 text-base text-on-color hover:bg-destructive/90"
                >
                  Disconnect
                </button>
              </footer>
            </>
          )}
        </Dialog>
      )}

      {signIn && (
        <SignInWizard
          title={`Connect ${signIn.provider.name}`}
          subtitle={signIn.method.label}
          start={(signal) => api().providers.connect({ providerId: signIn.provider.id, method: signIn.method.method }, { signal })}
          answer={(signInId, promptId, value) => api().providers.answer({ signInId, promptId, value })}
          onClose={(connected) => {
            setSignIn(undefined)
            if (connected) load()
          }}
        />
      )}
    </div>
  )
}

function ProviderRow({
  provider,
  row,
  active,
  onHover,
  onChoose,
}: {
  provider: ProviderInfo
  row: number
  active: boolean
  onHover: () => void
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      id={`provider-${provider.id}`}
      role="option"
      aria-selected={active}
      data-row={row}
      tabIndex={-1}
      onPointerMove={onHover}
      onClick={onChoose}
      className={cn('pressable flex w-full items-center gap-3 rounded-md px-2 py-2 text-left', active && 'bg-secondary')}
    >
      <ProviderLogo id={provider.id} name={provider.name} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-lg font-medium">{provider.name}</span>
        {popular[provider.id] && <span className="hidden truncate text-base text-muted-foreground sm:inline">{popular[provider.id]}</span>}
      </span>
      {provider.connection ? (
        <span className="flex shrink-0 items-center gap-1 rounded-sm bg-green/15 px-1.5 text-sm text-green-foreground">
          <svg aria-hidden viewBox="0 0 16 16" className="size-3">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Connected
        </span>
      ) : null}
    </button>
  )
}

/** How to connect a provider that offers more than one way: a subscription it already pays for first, then an API key. */
function MethodDialog({ provider, onClose }: { provider: ProviderInfo; onClose: (method?: Method) => void }) {
  const chosen = useRef<Method>(undefined)
  const methods = [...provider.methods].sort(byPreference)
  return (
    <Dialog label={`Connect ${provider.name}`} onClose={() => onClose(chosen.current)}>
      {(close) => (
        <>
          <header className="flex items-center gap-3">
            <ProviderLogo id={provider.id} name={provider.name} size={32} />
            <div className="flex flex-col">
              <h2 className="text-lg font-semibold">Connect {provider.name}</h2>
              <p className="text-sm text-muted-foreground">How do you want your bots to use it?</p>
            </div>
          </header>
          <div className="flex flex-col gap-2">
            {methods.map((method, index) => (
              <button
                key={method.method}
                type="button"
                data-autofocus={index === 0 || undefined}
                onClick={() => {
                  chosen.current = method
                  close()
                }}
                className="pressable flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-secondary"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-lg font-medium">{describe(method).title}</span>
                  <span className="text-sm text-muted-foreground">{describe(method).detail}</span>
                </span>
                {index === 0 && method.subscription && (
                  <span className="shrink-0 rounded-sm bg-secondary px-1.5 text-sm text-muted-foreground">Recommended</span>
                )}
                <svg aria-hidden viewBox="0 0 16 16" className="size-3 shrink-0 text-muted-foreground">
                  <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </div>
          <footer className="flex justify-end">
            <button type="button" onClick={close} className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover">
              Cancel
            </button>
          </footer>
        </>
      )}
    </Dialog>
  )
}

function describe(method: Method): { title: string; detail: string } {
  if (method.subscription) return { title: 'Use your subscription', detail: `Sign in with ${method.label.replace(/^sign in with /i, '')}; no key, no extra bill.` }
  if (method.method === 'oauth') return { title: 'Sign in', detail: method.label }
  return { title: 'Use an API key', detail: `Pay as you go with your ${method.label.replace(/^an? /i, '')}.` }
}
