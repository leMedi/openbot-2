// A stand-in for `cua-driver mcp`, for desktop.test.ts: an MCP server over stdio answering the driver's tools the way
// cua-driver 0.38 does on a screen (Xvfb), for one text editor window. Keys and focus-free typing are refused in the
// background, as there; every call is appended to the log file given as the first argument. Launching `exit` makes the
// first stand-in exit mid-call, as a driver restarting would.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.argv[2]
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const editor = { pid: 4242, window_id: 777, app_name: 'Mousepad', title: 'Untitled 1 - Mousepad', bounds: { x: 320, y: 166, width: 640, height: 480 } }
let launched = false
let snapshot = 0
let text = ''

const structured = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError })
const backgroundUnavailable = structured({ code: 'background_unavailable', detail: 'no focus-free input backend', hint: 'Retry with delivery_mode:"foreground".' }, true)

function tool(name, args) {
  const token = args.element_token
  const stale = token !== undefined && token.split(':')[0] !== `s${String(snapshot).padStart(8, '0')}`
  switch (name) {
    case 'list_windows':
      return structured({ windows: launched ? [editor] : [] })
    case 'launch_app':
      if (args.name !== 'mousepad') return structured({ error: `no app named ${args.name}` }, true)
      launched = true
      return structured({ pid: editor.pid, windows: [] })
    case 'get_window_state': {
      snapshot++
      const id = `s${String(snapshot).padStart(8, '0')}`
      const tree = `- frame = "${editor.title}"\n  - [0] push button "New" [actions=[click]]\n  - push button = "Undo" (disabled)\n  - [1] text "${text}" [actions=[]]\n`
      if (args.include_accessibility_tree === false) return { content: [{ type: 'image', data: png, mimeType: 'image/png' }], structuredContent: { snapshot_id: id } }
      return structured({ snapshot_id: id, tree_markdown: tree, window_title: editor.title, app_name: editor.app_name, window_bounds: editor.bounds })
    }
    case 'type_text':
      if (stale) return structured({ status: 'refused', refusal: { code: 'stale_element_token', message: 'element_token is stale' } })
      if (token) {
        text += args.text
        return structured({ effect: 'confirmed', route: 'accessibility', summary: `Typed into element [1]; it reads back '${text}'.` })
      }
      if (args.delivery_mode !== 'foreground') return backgroundUnavailable
      text += args.text
      return structured({ effect: 'unverifiable', summary: 'Typed as real key events.', hint: 'Read the field before typing again.' })
    case 'press_key':
    case 'hotkey':
      if (args.delivery_mode !== 'foreground') return backgroundUnavailable
      return structured({ effect: 'unverifiable', summary: `Pressed ${JSON.stringify(args.keys ?? args.key)}.`, hint: 'Three single actions in a row: send the next ones as one run_steps call.' })
    case 'click':
      if (stale) return structured({ status: 'refused', refusal: { code: 'stale_element_token', message: 'element_token is stale' } })
      if (token) return structured({ effect: 'unverifiable', summary: 'Clicked element [0] (pid 4242).' })
      return structured({ code: 'screenshot_context_missing', reason: 'no_screenshot' }, true)
    case 'scroll':
      return args.delivery_mode === 'foreground' ? structured({ effect: 'suspected_noop', summary: 'Scrolled; nothing moved.' }) : backgroundUnavailable
    case 'get_desktop_state':
      return { content: [{ type: 'image', data: png, mimeType: 'image/png' }], structuredContent: { screen_width: 1280 } }
    default:
      return structured({ error: `unknown tool ${name}` }, true)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let result
  if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '0' } }
  else if (message.method === 'tools/call') {
    if (log) appendFileSync(log, `${JSON.stringify({ tool: message.params.name, args: message.params.arguments })}\n`)
    if (message.params.name === 'launch_app' && message.params.arguments.name === 'exit' && !existsSync(`${log}.exited`)) {
      writeFileSync(`${log}.exited`, '')
      process.exit(0)
    }
    result = tool(message.params.name, message.params.arguments)
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
})
