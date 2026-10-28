import {
  type GeneralSettings,
  maxOwnerAboutLength,
  maxOwnerNameLength,
  type ModelInfo,
  type ModelSettings,
  type Onboarding,
  type ProviderInfo,
} from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { BotAvatar } from '../components/bot-avatar.tsx'
import { inputClass } from '../components/bot-fields.tsx'
import { NewBotForm } from '../components/new-bot-form.tsx'
import { ProviderList } from '../components/provider-list.tsx'
import { browserTimeZone, offsetOf, TimeZonePicker } from '../components/time-zone-picker.tsx'
import { api, errorMessage } from '../lib/api.ts'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

const steps = ['you', 'about', 'provider', 'models', 'bot'] as const
type Step = (typeof steps)[number]

/** Whether the server already has what `step` asks for. The description is optional, so it's done once the name is. */
const isDone = (step: Step, status: Onboarding) =>
  ({ you: status.profile, about: status.profile, provider: status.provider, models: status.defaultModel, bot: status.bot })[step]

/**
 * First run: the owner says who they are (name, time zone, a few words about themselves), connects a provider, picks
 * the models and creates a first bot. Steps already done are skipped, and Back revisits any of them.
 */
function OnboardingPage() {
  const navigate = useNavigate()
  const [general, setGeneral] = useState<GeneralSettings>()
  const [step, setStep] = useState<Step>()
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [error, setError] = useState<string>()

  useEffect(() => {
    Promise.all([api().onboarding.status(), api().general.getSettings()]).then(
      ([status, general]) => {
        if (status.done) return navigate({ to: '/', replace: true })
        setGeneral(general)
        setStep(steps.find((step) => !isDone(step, status)))
      },
      (caught) => setError(errorMessage(caught)),
    )
  }, [navigate])

  /** On to the next step not done yet, or into the app when none is left. The description always follows the name. */
  async function next(from: Step) {
    setError(undefined)
    try {
      const status = await api().onboarding.status()
      const later = steps.slice(steps.indexOf(from) + 1)
      const upcoming = from === 'you' ? 'about' : later.find((step) => !isDone(step, status))
      if (!upcoming) return navigate({ to: '/' })
      setDirection('forward')
      setStep(upcoming)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  function back(from: Step) {
    setDirection('back')
    setStep(steps[steps.indexOf(from) - 1])
  }

  const index = step ? steps.indexOf(step) : -1

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-10 px-6 pt-[10vh] pb-16">
        <header className="flex items-center justify-between gap-6">
          <span className="text-lg font-semibold tracking-tight">OpenBot</span>
          {step && <Progress index={index} />}
        </header>

        {error && <p className="text-destructive-foreground">{error}</p>}

        {step && general && (
          <section key={step} data-direction={direction} aria-labelledby="step-title">
            {step === 'you' && (
              <YouStep
                general={general}
                onSaved={(saved) => {
                  setGeneral(saved)
                  void next('you')
                }}
              />
            )}
            {step === 'about' && (
              <AboutStep
                general={general}
                onSaved={(saved) => {
                  setGeneral(saved)
                  void next('about')
                }}
                onBack={() => back('about')}
              />
            )}
            {step === 'provider' && <ProviderStep onDone={() => next('provider')} onBack={() => back('provider')} />}
            {step === 'models' && <ModelsStep onDone={() => next('models')} onBack={() => back('models')} />}
            {step === 'bot' && <BotStep onBack={() => back('bot')} />}
          </section>
        )}
      </div>
    </main>
  )
}

/** One segment per step, filled up to and including the current one. */
function Progress({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground tabular-nums">
        {index + 1} of {steps.length}
      </span>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={index + 1}
        className="flex w-32 gap-1"
      >
        {steps.map((step, position) => (
          <span key={step} className="h-1 flex-1 overflow-hidden rounded-full bg-control-track">
            <span
              className={cn(
                'block h-full origin-left rounded-full bg-foreground transition-transform duration-500 ease-out-quint motion-reduce:transition-none',
                position <= index ? 'scale-x-100' : 'scale-x-0',
              )}
            />
          </span>
        ))}
      </div>
    </div>
  )
}

function StepHeader({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 id="step-title" className="text-[28px] leading-[34px] font-semibold tracking-[-0.02em] text-balance">
        {title}
      </h1>
      <p className="text-lg text-muted-foreground text-pretty">{description}</p>
    </header>
  )
}

/**
 * Back on the left, the way forward on the right, with `extra` just before it. Continue submits the step's form, or
 * calls `onContinue` for a step that isn't one.
 */
function StepFooter({
  onBack,
  onContinue,
  extra,
  continueLabel = 'Continue',
  disabled = false,
  busy = false,
}: {
  onBack?: () => void
  onContinue?: () => void
  extra?: React.ReactNode
  continueLabel?: string
  disabled?: boolean
  busy?: boolean
}) {
  return (
    <footer className="flex items-center gap-2 pt-2">
      {onBack && (
        <button type="button" onClick={onBack} className="pressable rounded-md px-3 py-2 text-base text-muted-foreground hover:bg-secondary hover:text-foreground">
          Back
        </button>
      )}
      <span className="flex-1" />
      {extra}
      <button
        type={onContinue ? 'button' : 'submit'}
        onClick={onContinue}
        disabled={disabled || busy}
        className="pressable min-w-24 rounded-md bg-primary px-4 py-2 text-base font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
      >
        {busy ? 'Saving…' : continueLabel}
      </button>
    </footer>
  )
}

const bigInputClass = cn(inputClass, 'rounded-lg px-3 py-2.5 text-lg')

/** The current time, ticking each half minute. */
function useNow() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** The owner's name, and their time zone: the one already set (detected from this browser), or this browser's. */
function YouStep({ general, onSaved }: { general: GeneralSettings; onSaved: (general: GeneralSettings) => void }) {
  const [name, setName] = useState(general.name ?? '')
  const [timeZone, setTimeZone] = useState(general.timeZone ?? browserTimeZone())
  const [changing, setChanging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const now = useNow()
  const localTime = new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(now)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      if (timeZone !== general.timeZone) await api().general.updateSettings({ timeZone })
      onSaved(await api().general.updateProfile({ name: name.trim() }))
    } catch (caught) {
      setError(errorMessage(caught))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="onboarding-step flex flex-col gap-6">
      <WelcomeMark />
      <StepHeader
        title="Welcome. What should your bots call you?"
        description="Your bots run on your own machine and work for you around the clock. They'll know you by this name, and plan around your local time."
      />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="owner-name" className="font-medium">
          Your name
        </label>
        <input
          id="owner-name"
          required
          autoFocus
          autoComplete="given-name"
          maxLength={maxOwnerNameLength}
          placeholder="Sam"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={bigInputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-muted-foreground">Time zone</span>
            <span className="truncate text-lg font-medium">{timeZone.replaceAll('_', ' ')}</span>
            <span className="text-sm text-muted-foreground tabular-nums">
              {offsetOf(timeZone)} · {localTime} there now
            </span>
          </div>
          <button
            type="button"
            aria-expanded={changing}
            aria-controls="time-zone-search"
            onClick={() => setChanging(!changing)}
            className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover"
          >
            {changing ? 'Done' : 'Change'}
          </button>
        </div>
        {changing && (
          <div className="motion-safe:animate-rise-in motion-reduce:animate-fade-in">
            <TimeZonePicker
              id="time-zone-search"
              autoFocus
              value={timeZone}
              onChange={(chosen) => {
                setTimeZone(chosen)
                setChanging(false)
              }}
            />
          </div>
        )}
      </div>

      {error && <p className="text-destructive-foreground">{error}</p>}
      <StepFooter disabled={!name.trim()} busy={busy} />
    </form>
  )
}

/** A few of the bots to come, as a hello. */
function WelcomeMark() {
  const crew = [
    { shape: 'blob', color: 'blue' },
    { shape: 'hex', color: 'orange' },
    { shape: 'cloud', color: 'violet' },
  ] as const
  return (
    <div aria-hidden className="flex -space-x-2">
      {crew.map((bot, position) => (
        <span
          key={bot.shape}
          className="motion-safe:animate-pop-in motion-reduce:animate-fade-in"
          style={{ animationDelay: `${120 + position * 60}ms` }}
        >
          <BotAvatar shape={bot.shape} color={bot.color} size={40} />
        </span>
      ))}
    </div>
  )
}

/** Starting points for the description; each adds its words on a line of its own, for the owner to finish. */
const starters = [
  { label: 'What I do', text: 'I work as ' },
  { label: "Where I'm based", text: 'I live in ' },
  { label: 'People I mention', text: 'People I often mention: ' },
  { label: 'How I like replies', text: 'I like replies that are ' },
]

/** A few words the owner writes about themselves for every bot; optional. */
function AboutStep({ general, onSaved, onBack }: { general: GeneralSettings; onSaved: (general: GeneralSettings) => void; onBack: () => void }) {
  const [about, setAbout] = useState(general.about)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const firstName = general.name?.split(/\s+/)[0]

  function start(text: string) {
    const next = about.trim() ? `${about.trimEnd()}\n${text}` : text
    setAbout(next)
    // Leave the caret where the owner goes on writing.
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(next.length, next.length)
    })
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      onSaved(about.trim() === general.about ? general : await api().general.updateProfile({ about: about.trim() }))
    } catch (caught) {
      setError(errorMessage(caught))
      setBusy(false)
    }
  }

  const remaining = maxOwnerAboutLength - about.length

  return (
    <form onSubmit={save} className="onboarding-step flex flex-col gap-6">
      <StepHeader
        title={firstName ? `Nice to meet you, ${firstName}. Tell your bots about yourself.` : 'Tell your bots about yourself.'}
        description="Every bot reads this before it works for you, so it's the place for what you'd tell a new colleague. You can change it any time in Settings."
      />

      <div className="flex flex-col gap-2">
        <label htmlFor="owner-about" className="sr-only">
          About you
        </label>
        <textarea
          ref={textarea}
          id="owner-about"
          autoFocus
          rows={6}
          maxLength={maxOwnerAboutLength}
          placeholder="I'm a product designer in Lisbon. I keep my notes in Notion and like short, direct answers."
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          onKeyDown={(event) => {
            // ⌘/Ctrl+Enter goes on, as Enter does in a one-line field.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit()
          }}
          className={cn(bigInputClass, 'resize-none leading-[22px]')}
        />
        <div className="flex items-start gap-3">
          <div className="flex flex-1 flex-wrap gap-1.5">
            {starters.map((starter) => (
              <button
                key={starter.label}
                type="button"
                onClick={() => start(starter.text)}
                className="pressable rounded-full border border-border px-2.5 py-1 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <span aria-hidden>+ </span>
                {starter.label}
              </button>
            ))}
          </div>
          {remaining < 300 && <span className="pt-1 text-sm text-muted-foreground tabular-nums">{remaining}</span>}
        </div>
      </div>

      {error && <p className="text-destructive-foreground">{error}</p>}
      <StepFooter onBack={onBack} busy={busy} continueLabel={about.trim() ? 'Continue' : 'Skip for now'} />
    </form>
  )
}

/** Connects one provider or more; goes on once any is connected. Not a form: sign-in dialogs have their own. */
function ProviderStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [connected, setConnected] = useState<ProviderInfo[]>()

  return (
    <div className="onboarding-step flex flex-col gap-6">
      <StepHeader
        title="Connect a model provider"
        description="Your bots think with a provider's models. Add an API key, or sign in with a subscription you already pay for. You can add more later."
      />
      <ProviderList onChange={(providers) => setConnected(providers.filter((provider) => provider.connection))} />
      <StepFooter
        onBack={onBack}
        onContinue={onDone}
        disabled={!connected?.length}
        extra={connected?.length === 0 && <span className="text-sm text-muted-foreground">Connect one to continue</span>}
      />
    </div>
  )
}

/** The model setting a bot follows unless it has its own: shown as "same as …", saved as null. */
const unset = ''

/** The default model, picked from connected providers' models, and, if the owner wants, the computer-use and memory models. */
function ModelsStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [models, setModels] = useState<ModelInfo[]>()
  const [choice, setChoice] = useState<Pick<ModelSettings, 'defaultModel'> & { computerUseModel: string; memoryModel: string }>()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    Promise.all([api().models.list(), api().models.getSettings()]).then(
      ([models, settings]) => {
        setModels(models)
        setChoice({
          defaultModel: models.some((model) => model.ref === settings.defaultModel) ? settings.defaultModel : (models[0]?.ref ?? null),
          computerUseModel: settings.computerUseModel ?? unset,
          memoryModel: settings.memoryModel ?? unset,
        })
      },
      (caught) => setError(errorMessage(caught)),
    )
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!choice?.defaultModel) return
    setError(undefined)
    setBusy(true)
    try {
      await api().models.updateSettings({
        defaultModel: choice.defaultModel,
        computerUseModel: choice.computerUseModel || null,
        memoryModel: choice.memoryModel || null,
      })
      onDone()
    } catch (caught) {
      setError(errorMessage(caught))
      setBusy(false)
    }
  }

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = models?.filter((model) => words.every((word) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(word)))
  const providers = [...new Set(shown?.map((model) => model.provider))]
  const defaultModel = models?.find((model) => model.ref === choice?.defaultModel)

  return (
    <form onSubmit={save} className="onboarding-step flex flex-col gap-6">
      <StepHeader
        title="Pick your bots' model"
        description="Every bot uses it unless you give that bot its own. You can switch any time in Settings → Models."
      />

      <div className="flex flex-col gap-3">
        {models && models.length > 8 && (
          <input
            type="search"
            aria-label="Search models"
            placeholder="Search models"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
            className={inputClass}
          />
        )}
        {!models && !error && <p className="text-muted-foreground">Loading models…</p>}
        {models?.length === 0 && <p className="text-muted-foreground">No models yet: go back and connect a provider.</p>}

        <div role="radiogroup" aria-label="Default model" className="flex max-h-[min(420px,50vh)] flex-col gap-4 overflow-y-auto">
          {providers.map((provider) => (
            <div key={provider} className="flex flex-col gap-1.5">
              {providers.length > 1 && <h2 className="px-1 text-sm font-medium text-muted-foreground">{provider}</h2>}
              {shown!
                .filter((model) => model.provider === provider)
                .map((model) => (
                  <ModelOption
                    key={model.ref}
                    model={model}
                    checked={model.ref === choice?.defaultModel}
                    onChoose={() => setChoice((choice) => choice && { ...choice, defaultModel: model.ref })}
                  />
                ))}
            </div>
          ))}
          {shown?.length === 0 && models!.length > 0 && <p className="px-1 text-muted-foreground">No model matches.</p>}
        </div>
      </div>

      {models && choice && models.length > 0 && (
        <details className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 select-none [&::-webkit-details-marker]:hidden">
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              className="size-3 text-muted-foreground transition-transform duration-200 ease-out group-open:rotate-90 motion-reduce:transition-none"
            >
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="font-medium">Screens and memory</span>
            <span className="text-sm text-muted-foreground">Optional</span>
          </summary>
          <div className="flex flex-col gap-4 px-3 pb-3">
            <ModelChoice
              id="computer-use-model"
              label="Computer-use model"
              hint="Drives bots' screens, so it must understand images."
              value={choice.computerUseModel}
              models={models.filter((model) => model.vision)}
              placeholder="Same as each bot's model"
              onChange={(computerUseModel) => setChoice({ ...choice, computerUseModel })}
            />
            {!choice.computerUseModel && defaultModel && !defaultModel.vision && (
              <p className="-mt-2 text-sm text-amber-foreground">
                {defaultModel.name} can't see images: bots on it work their screens from snapshots alone.
              </p>
            )}
            <ModelChoice
              id="memory-model"
              label="Memory model"
              hint="Picks out what bots should remember after each run; a small, cheap model does."
              value={choice.memoryModel}
              models={models}
              placeholder="Same as the default"
              onChange={(memoryModel) => setChoice({ ...choice, memoryModel })}
            />
          </div>
        </details>
      )}

      {error && <p className="text-destructive-foreground">{error}</p>}
      <StepFooter onBack={onBack} disabled={!choice?.defaultModel} busy={busy} />
    </form>
  )
}

function ModelOption({ model, checked, onChoose }: { model: ModelInfo; checked: boolean; onChoose: () => void }) {
  return (
    <label
      className={cn(
        'pressable flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5',
        checked ? 'border-foreground bg-secondary' : 'border-border hover:bg-secondary',
      )}
    >
      <input type="radio" name="default-model" value={model.ref} checked={checked} onChange={onChoose} className="peer sr-only" />
      <span
        aria-hidden
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue',
          checked ? 'border-foreground bg-foreground' : 'border-border-strong',
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-background motion-safe:animate-pop-in" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-lg font-medium">{model.name}</span>
        <span className="truncate text-sm text-muted-foreground">{model.id}</span>
      </span>
      {model.vision && <span className="shrink-0 rounded-sm bg-blue-subtle px-1.5 text-sm text-blue-foreground">Sees images</span>}
    </label>
  )
}

function ModelChoice({
  id,
  label,
  hint,
  value,
  models,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  models: ModelInfo[]
  placeholder: string
  onChange: (ref: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
        <option value={unset}>{placeholder}</option>
        {models.map((model) => (
          <option key={model.ref} value={model.ref}>
            {model.name} · {model.provider}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The first bot; creating it opens its chat. */
function BotStep({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="onboarding-step flex flex-col gap-6">
      <StepHeader title="Create your first bot" description="Give it a name and say who it is. You'll be chatting with it right away." />
      <NewBotForm
        submitLabel="Start chatting"
        cancelLabel="Back"
        onCancel={onBack}
        onCreated={(bot) => navigate({ to: '/bots/$botId', params: { botId: bot.id } })}
      />
    </div>
  )
}
