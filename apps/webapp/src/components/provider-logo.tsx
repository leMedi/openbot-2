import { cn } from '@openbot/ui/lib/utils'

/**
 * The providers with a logo in `public/providers`: models.dev's monochrome marks, a provider's own or its parent's
 * (e.g. Vercel's for Vercel AI Gateway). The rest get their initial.
 */
const logos = new Set([
  'amazon-bedrock',
  'anthropic',
  'azure',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google-vertex',
  'google',
  'groq',
  'huggingface',
  'kimi-coding',
  'meta',
  'minimax-cn',
  'minimax',
  'mistral',
  'moonshotai-cn',
  'moonshotai',
  'nvidia',
  'openai-codex',
  'openai',
  'opencode-go',
  'opencode',
  'openrouter',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'qwen-token-plan',
  'together',
  'vercel-ai-gateway',
  'xai',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'xiaomi',
  'zai-coding-cn',
  'zai',
])

/** A provider's mark in the current text color, so it follows light and dark mode; its initial on a tile without one. */
export function ProviderLogo({ id, name, size = 20, className }: { id: string; name: string; size?: number; className?: string }) {
  if (!logos.has(id)) {
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
        className={cn('grid shrink-0 place-items-center rounded-[5px] bg-secondary font-semibold text-muted-foreground', className)}
      >
        {name.trim().charAt(0).toUpperCase()}
      </span>
    )
  }
  const mask = `url(/providers/${id}.svg) center / contain no-repeat`
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, backgroundColor: 'currentColor', mask, WebkitMask: mask }}
      className={cn('block shrink-0', className)}
    />
  )
}
