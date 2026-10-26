import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
  h1: ({ children }) => <h1 className="my-1 text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-1 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-1 font-semibold">{children}</h3>,
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-border-strong pl-3 text-muted-foreground">{children}</blockquote>,
  hr: () => <hr className="my-2 border-border" />,
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-lg bg-black/5 p-3 font-mono text-sm leading-5 dark:bg-white/10 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded-sm bg-black/10 px-1 font-mono text-[0.9em] dark:bg-white/15">{children}</code>,
}

/** A message's Markdown, with GitHub extensions (tables, task lists, strikethrough, autolinks). */
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
}
