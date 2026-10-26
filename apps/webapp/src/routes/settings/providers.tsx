import type { ProviderInfo } from '@openbot/api-contract'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { SignInWizard } from '../../components/sign-in-wizard.tsx'
import { api, errorMessage } from '../../lib/api.ts'

export const Route = createFileRoute('/settings/providers')({
  component: Providers,
})

type Method = ProviderInfo['methods'][number]

function Providers() {
  const [providers, setProviders] = useState<ProviderInfo[]>()
  const [error, setError] = useState<string>()
  const [signIn, setSignIn] = useState<{ provider: ProviderInfo; method: Method }>()

  const load = useCallback(() => {
    api().providers.list().then(setProviders, (caught) => setError(errorMessage(caught)))
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

  // Connected providers first, then by name.
  const sorted = providers && [...providers].sort(
    (a, b) => Number(!!b.connection) - Number(!!a.connection) || a.name.localeCompare(b.name),
  )

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold">Providers</h2>
        <p className="text-base text-muted-foreground">
          Connect the model vendors and subscriptions your bots can use. Keys and sign-ins are stored encrypted on this
          machine and are never shown again.
        </p>
      </header>

      {error && <p className="text-destructive-foreground">{error}</p>}
      {!sorted && !error && <p className="text-muted-foreground">Loading…</p>}

      <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
        {sorted?.map((provider) => (
          <li key={provider.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-lg font-medium">{provider.name}</span>
                {provider.connection && (
                  <span className="rounded-sm bg-green/15 px-1.5 text-sm text-green-foreground">
                    Connected{provider.connection.method === 'oauth' ? ' (signed in)' : ' (API key)'}
                  </span>
                )}
                {provider.methods.some((method) => method.subscription) && (
                  <span className="rounded-sm bg-purple/15 px-1.5 text-sm text-purple-foreground">Subscription</span>
                )}
              </div>
            </div>
            {provider.connection ? (
              <button
                type="button"
                className="rounded-md bg-secondary px-3 py-1.5 text-base hover:bg-secondary-hover"
                onClick={() => disconnect(provider)}
              >
                Disconnect
              </button>
            ) : (
              <div className="flex gap-2">
                {provider.methods.map((method) => (
                  <button
                    key={method.method}
                    type="button"
                    className="rounded-md bg-primary px-3 py-1.5 text-base text-primary-foreground hover:bg-primary-hover"
                    onClick={() => setSignIn({ provider, method })}
                  >
                    {method.method === 'api_key' ? 'Add API key' : method.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {signIn && (
        <SignInWizard
          provider={signIn.provider}
          method={signIn.method}
          onClose={(connected) => {
            setSignIn(undefined)
            if (connected) load()
          }}
        />
      )}
    </section>
  )
}
