import type { ModelInfo, Onboarding } from '@openbot/api-contract'
import { cn } from '@openbot/ui/lib/utils'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { NewBotForm } from '../components/new-bot-form.tsx'
import { ProviderList } from '../components/provider-list.tsx'
import { api, errorMessage } from '../lib/api.ts'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

const steps = [
  { key: 'provider', title: 'Connect a provider', description: 'An API key or a subscription your bots run on.' },
  { key: 'defaultModel', title: 'Pick the default model', description: 'Every bot uses it unless it has its own.' },
  { key: 'bot', title: 'Create your first bot', description: 'Give it a name and instructions; you can chat right away.' },
] as const

/** First run: connect a provider, pick the default model, create a first bot. */
function OnboardingPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<Onboarding>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(() => {
    api().onboarding.status().then(setStatus, (caught) => setError(errorMessage(caught)))
  }, [])
  useEffect(refresh, [refresh])

  const current = status && steps.find((step) => !status[step.key])

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-12">
        <header>
          <h1 className="text-[28px] leading-[34px] font-medium tracking-tight">Welcome to OpenBot</h1>
          <p className="text-lg text-muted-foreground">Your team of always-on bots, on your own machine.</p>
        </header>

        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <li key={step.key} className="flex items-center gap-3">
              <span
                className={cn(
                  'grid size-6 place-items-center rounded-full text-sm',
                  status?.[step.key] ? 'bg-green/15 text-green-foreground' : step === current ? 'bg-primary text-primary-foreground' : 'bg-secondary',
                )}
              >
                {status?.[step.key] ? '✓' : index + 1}
              </span>
              <span className={step === current ? 'font-medium' : 'text-muted-foreground'}>{step.title}</span>
            </li>
          ))}
        </ol>

        {error && <p className="text-destructive-foreground">{error}</p>}

        {current && (
          <section className="flex flex-col gap-4 rounded-xl border border-border p-5">
            <header>
              <h2 className="text-lg font-semibold">{current.title}</h2>
              <p className="text-muted-foreground">{current.description}</p>
            </header>
            {current.key === 'provider' && (
              <ProviderList onChange={(providers) => providers.some((provider) => provider.connection) && refresh()} />
            )}
            {current.key === 'defaultModel' && <DefaultModelStep onChosen={refresh} />}
            {current.key === 'bot' && (
              <NewBotForm
                submitLabel="Get started"
                onCreated={(bot) => navigate({ to: '/bots/$botId', params: { botId: bot.id } })}
              />
            )}
          </section>
        )}

        {status?.done && (
          <button
            type="button"
            onClick={() => navigate({ to: '/' })}
            className="self-start rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary-hover"
          >
            Open OpenBot
          </button>
        )}
      </div>
    </main>
  )
}

function DefaultModelStep({ onChosen }: { onChosen: () => void }) {
  const [models, setModels] = useState<ModelInfo[]>()
  const [choice, setChoice] = useState('')
  const [error, setError] = useState<string>()

  useEffect(() => {
    api()
      .models.list()
      .then(
        (models) => {
          setModels(models)
          setChoice(models[0]?.ref ?? '')
        },
        (caught) => setError(errorMessage(caught)),
      )
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    try {
      await api().models.updateSettings({ defaultModel: choice })
      onChosen()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <select
        aria-label="Default model"
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        className="rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base"
      >
        {models?.map((model) => (
          <option key={model.ref} value={model.ref}>
            {model.name} · {model.provider}
          </option>
        ))}
      </select>
      {error && <p className="text-destructive-foreground">{error}</p>}
      <button
        type="submit"
        disabled={!choice}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
      >
        Continue
      </button>
    </form>
  )
}
