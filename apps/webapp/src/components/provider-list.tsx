import type { ProviderInfo } from '@openbot/api-contract'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { SignInWizard } from './sign-in-wizard.tsx'

type Method = ProviderInfo['methods'][number]

/** Every provider, connected ones first, with Connect and Disconnect. `onChange` follows each change. */
export function ProviderList({ onChange }: { onChange?: (providers: ProviderInfo[]) => void }) {
  const [providers, setProviders] = useState<ProviderInfo[]>()
  const [error, setError] = useState<string>()
  const [signIn, setSignIn] = useState<{ provider: ProviderInfo; method: Method }>()

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

  // Connected providers first, then by name.
  const sorted = providers && [...providers].sort(
    (a, b) => Number(!!b.connection) - Number(!!a.connection) || a.name.localeCompare(b.name),
  )

  return (
    <div className="flex flex-col gap-4">
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
    </div>
  )
}
