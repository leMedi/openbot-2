import { createFileRoute } from '@tanstack/react-router'
import { ProviderList } from '../../components/provider-list.tsx'

export const Route = createFileRoute('/settings/providers')({
  component: Providers,
})

function Providers() {
  return (
    <section className="flex flex-col gap-4">
      <header>
        <h2 className="text-xl font-semibold">Providers</h2>
        <p className="text-base text-muted-foreground">
          Connect the model vendors and subscriptions your bots can use. Keys and sign-ins are stored encrypted on this
          machine and are never shown again.
        </p>
      </header>
      <ProviderList />
    </section>
  )
}
