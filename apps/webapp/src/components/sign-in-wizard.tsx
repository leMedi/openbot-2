import type { ProviderInfo, SignInStep } from '@openbot/api-contract'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'

type Prompt = Extract<SignInStep, { type: 'prompt' }>
type Method = ProviderInfo['methods'][number]

/**
 * Runs a provider sign-in on the server and shows each step: links to open, device codes, prompts to answer.
 * Closing the wizard ends the stream, which cancels the sign-in.
 */
export function SignInWizard({
  provider,
  method,
  onClose,
}: {
  provider: ProviderInfo
  method: Method
  /** `connected` is true when the sign-in succeeded. */
  onClose: (connected: boolean) => void
}) {
  const [steps, setSteps] = useState<SignInStep[]>([])
  const [signInId, setSignInId] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const stream = await api().providers.connect(
          { providerId: provider.id, method: method.method },
          { signal: controller.signal },
        )
        for await (const step of stream) {
          if (step.type === 'started') setSignInId(step.signInId)
          setSteps((previous) => [...previous, step])
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(errorMessage(caught))
      }
    })()
    return () => controller.abort()
  }, [provider.id, method.method])

  const closed = new Set(steps.flatMap((step) => (step.type === 'prompt_closed' ? [step.promptId] : [])))
  const connected = steps.some((step) => step.type === 'connected')
  const failed = steps.find((step) => step.type === 'failed')
  const openPrompt = steps.filter((step): step is Prompt => step.type === 'prompt' && !closed.has(step.promptId)).at(-1)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-scrim p-4">
      <div
        role="dialog"
        aria-label={`Connect ${provider.name}`}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl bg-popover p-5 text-popover-foreground shadow-lg"
      >
        <header>
          <h2 className="text-lg font-semibold">Connect {provider.name}</h2>
          <p className="text-sm text-muted-foreground">{method.label}</p>
        </header>

        <ol className="flex flex-col gap-3 text-base">
          {steps.map((step, index) => (
            <StepView key={index} step={step} />
          ))}
        </ol>

        {openPrompt && signInId && !connected && !failed && (
          <PromptForm key={openPrompt.promptId} prompt={openPrompt} signInId={signInId} onError={setError} />
        )}

        {connected && <p className="text-green-foreground">Connected.</p>}
        {failed && <p className="text-destructive-foreground">{failed.message}</p>}
        {error && <p className="text-destructive-foreground">{error}</p>}

        <footer className="flex justify-end">
          <button
            type="button"
            className="rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover"
            onClick={() => onClose(connected)}
          >
            {connected || failed ? 'Done' : 'Cancel'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function StepView({ step }: { step: SignInStep }) {
  switch (step.type) {
    case 'auth_url':
      return (
        <li className="flex flex-col gap-1">
          <a href={step.url} target="_blank" rel="noreferrer" className="font-medium text-link underline">
            Open the sign-in page
          </a>
          {step.instructions && <span className="text-muted-foreground">{step.instructions}</span>}
        </li>
      )
    case 'device_code':
      return (
        <li className="flex flex-col gap-1">
          <span>
            Go to{' '}
            <a href={step.verificationUri} target="_blank" rel="noreferrer" className="text-link underline">
              {step.verificationUri}
            </a>{' '}
            and enter this code:
          </span>
          <code className="self-start rounded-md bg-muted px-2 py-1 font-mono text-xl tracking-widest">{step.userCode}</code>
        </li>
      )
    case 'info':
      return (
        <li className="flex flex-col gap-1">
          <span>{step.message}</span>
          {step.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="text-link underline">
              {link.label ?? link.url}
            </a>
          ))}
        </li>
      )
    case 'progress':
      return <li className="text-muted-foreground">{step.message}</li>
    default:
      return null
  }
}

function PromptForm({ prompt, signInId, onError }: { prompt: Prompt; signInId: string; onError: (error: string) => void }) {
  const [value, setValue] = useState(prompt.options?.[0]?.id ?? '')
  const [sending, setSending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSending(true)
    try {
      await api().providers.answer({ signInId, promptId: prompt.promptId, value })
    } catch (caught) {
      onError(errorMessage(caught))
      setSending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label className="text-base font-medium" htmlFor={prompt.promptId}>
        {prompt.message}
      </label>
      {prompt.kind === 'manual_code' && (
        <p className="text-sm text-muted-foreground">
          If the sign-in page ends on an address that doesn't load, copy that whole address from your browser and paste it
          here.
        </p>
      )}
      {prompt.kind === 'select' ? (
        <div className="flex flex-col gap-1">
          {prompt.options?.map((option) => (
            <label key={option.id} className="flex items-start gap-2 rounded-md p-2 hover:bg-secondary">
              <input
                type="radio"
                name={prompt.promptId}
                value={option.id}
                checked={value === option.id}
                onChange={() => setValue(option.id)}
              />
              <span className="flex flex-col">
                <span>{option.label}</span>
                {option.description && <span className="text-sm text-muted-foreground">{option.description}</span>}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <input
          id={prompt.promptId}
          type={prompt.kind === 'secret' ? 'password' : 'text'}
          autoComplete="off"
          autoFocus
          placeholder={prompt.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-none focus:border-ring"
        />
      )}
      <button
        type="submit"
        disabled={sending || !value}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
      >
        Continue
      </button>
    </form>
  )
}
