import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { describeComputerContract } from './computer-contract.ts'
import { createFakeComputer } from './fake-computer.ts'

const rex = { id: 'bot-rex', name: 'Rex', display: 1 }

describeComputerContract('the fake computer', async () => {
  // The fake has no shell; scripted to answer the contract's commands as the computer would.
  const computer = createFakeComputer({
    shell: (command, bot) => {
      if (command === 'whoami; sudo --non-interactive whoami; pwd') return { stdout: `openbot\nroot\n/home/openbot/bots/${bot.id}\n`, stderr: '', exitCode: 0 }
      if (command === 'echo oops >&2; exit 3') return { stdout: '', stderr: 'oops\n', exitCode: 3 }
      return undefined
    },
  })
  return {
    computer,
    reconnect: async () => computer,
    crash: (bot) => computer.crash(bot),
    user: 'openbot',
    folder: (bot) => join('/home/openbot/bots', bot.id),
    close: () => computer.close(),
  }
})

describe('fake computer', () => {
  it('records screen, shell and browser calls in order', async () => {
    const computer = createFakeComputer()

    await computer.screens.start(rex)
    await computer.shell.exec(rex, 'ls ~')
    await computer.browser.navigate(rex, 'https://example.com')
    await computer.browser.click(rex, 'e3')
    await computer.browser.type(rex, 'e4', 'hello')
    await computer.close()

    expect(computer.calls).toEqual([
      { bot: 'Rex', kind: 'screens.start', display: 1 },
      { bot: 'Rex', kind: 'shell.exec', command: 'ls ~' },
      { bot: 'Rex', kind: 'browser.navigate', url: 'https://example.com' },
      { bot: 'Rex', kind: 'browser.click', ref: 'e3' },
      { bot: 'Rex', kind: 'browser.type', ref: 'e4', text: 'hello' },
    ])
  })

  it('keeps a started screen running until stopped', async () => {
    const computer = createFakeComputer()

    expect((await computer.screens.status(rex)).state).toBe('stopped')
    await computer.screens.start(rex)
    expect((await computer.screens.status(rex)).state).toBe('running')
    await computer.screens.stop(rex)
    expect((await computer.screens.status(rex)).state).toBe('stopped')
    await computer.close()
  })

  it('answers shell commands from a script, succeeding silently otherwise', async () => {
    const computer = createFakeComputer({
      shell: (command) => (command === 'whoami' ? { stdout: 'openbot\n', stderr: '', exitCode: 0 } : undefined),
    })

    expect(await computer.shell.exec(rex, 'whoami')).toEqual({ stdout: 'openbot\n', stderr: '', exitCode: 0 })
    expect(await computer.shell.exec(rex, 'true')).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  })

  it('reports the page the browser navigated to', async () => {
    const computer = createFakeComputer()

    await computer.browser.navigate(rex, 'https://example.com')

    expect((await computer.browser.snapshot(rex)).url).toBe('https://example.com')
  })
})
