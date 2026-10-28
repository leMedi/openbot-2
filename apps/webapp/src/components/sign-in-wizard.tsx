import type { SignInStep } from '@openbot/api-contract'
import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/api.ts'
import { Dialog } from './dialog.tsx'

type Prompt = Extract<SignInStep, { type: 'prompt' }>

/** Answers an open prompt of the running sign-in. */
type Answer = (signInId: string, promptId: string, value: string) => Promise<void>

/**
 * Runs a sign-in on the server (a provider's or a plugin account's) and shows each step: links to open, device codes,
 * prompts to answer. Closing the wizard ends the stream, which cancels the sign-in.
 */
export function SignInWizard({
  title,
  subtitle,
  start,
  answer,
  onClose,
}: {
  title: string
  subtitle?: string
  /** Starts the sign-in, streaming its steps; called once. */
  start: (signal: AbortSignal) => Promise<AsyncIterable<SignInStep>>
  answer: Answer
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
        const stream = await start(controller.signal)
        for await (const step of stream) {
          if (step.type === 'started') setSignInId(step.signInId)
          setSteps((previous) => [...previous, step])
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(errorMessage(caught))
      }
    })()
    return () => controller.abort()
    // The sign-in starts once, when the wizard opens.
  }, [])

  const closed = new Set(steps.flatMap((step) => (step.type === 'prompt_closed' ? [step.promptId] : [])))
  const connected = steps.some((step) => step.type === 'connected')
  const failed = steps.find((step) => step.type === 'failed')
  const openPrompt = steps.filter((step): step is Prompt => step.type === 'prompt' && !closed.has(step.promptId)).at(-1)

  return (
    <Dialog label={title} onClose={() => onClose(connected)}>
      {(close) => (
        <>
          <header>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </header>

          <ol className="flex flex-col gap-3 text-base">
            {steps.map((step, index) => (
              <StepView key={index} step={step} />
            ))}
          </ol>

          {openPrompt && signInId && !connected && !failed && (
            <PromptForm key={openPrompt.promptId} prompt={openPrompt} signInId={signInId} answer={answer} onError={setError} />
          )}

          {connected && <p className="text-green-foreground">Connected.</p>}
          {failed && <p className="text-destructive-foreground">{failed.message}</p>}
          {error && <p className="text-destructive-foreground">{error}</p>}

          <footer className="flex justify-end">
            <button
              type="button"
              className="pressable rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover"
              onClick={close}
            >
              {connected || failed ? 'Done' : 'Cancel'}
            </button>
          </footer>
        </>
      )}
    </Dialog>
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

function PromptForm({
  prompt,
  signInId,
  answer,
  onError,
}: {
  prompt: Prompt
  signInId: string
  answer: Answer
  onError: (error: string) => void
}) {
  const [value, setValue] = useState(prompt.options?.[0]?.id ?? '')
  const [sending, setSending] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSending(true)
    try {
      await answer(signInId, prompt.promptId, value)
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
          className="rounded-md border border-input bg-input-fill px-2.5 py-1.5 text-base outline-offset-0"
        />
      )}
      <button
        type="submit"
        disabled={sending || !value}
        className="pressable self-end rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
      >
        Continue
      </button>
    </form>
  )
}
