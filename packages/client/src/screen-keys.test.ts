import { describe, expect, it } from 'vitest'
import { inputChange, pressKey, typeChange, typeText } from './screen-keys.ts'

/** Records the keys sent, as noVNC's client would send them. */
function keyboard() {
  const sent: string[] = []
  return {
    sent,
    rfb: {
      sendKey(keysym: number, code: string, down?: boolean) {
        sent.push(`${keysym.toString(16)}${down === undefined ? '' : down ? '↓' : '↑'}${code ? `:${code}` : ''}`)
      },
    },
  }
}

describe('typeText', () => {
  it('types letters, digits and Latin-1 as their own keysyms, newlines as Enter', () => {
    const { rfb, sent } = keyboard()
    typeText(rfb, 'aZ9 é\n')
    expect(sent).toEqual(['61', '5a', '39', '20', 'e9', 'ff0d:Enter'])
  })

  it('types other characters as Unicode keysyms, one per character even beyond the BMP', () => {
    const { rfb, sent } = keyboard()
    typeText(rfb, '€😀')
    expect(sent).toEqual(['10020ac', '101f600'])
  })

  it('holds the modifiers down around the first key only', () => {
    const { rfb, sent } = keyboard()
    typeText(rfb, 'ca', ['ctrl', 'alt'])
    expect(sent).toEqual(['ffe3↓:ControlLeft', 'ffe9↓:AltLeft', '63', 'ffe9↑:AltLeft', 'ffe3↑:ControlLeft', '61'])
  })
})

describe('pressKey', () => {
  it('sends the special keys with their codes', () => {
    const { rfb, sent } = keyboard()
    for (const key of ['escape', 'tab', 'enter', 'left', 'up', 'right', 'down', 'backspace'] as const) pressKey(rfb, key)
    expect(sent).toEqual(['ff1b:Escape', 'ff09:Tab', 'ff0d:Enter', 'ff51:ArrowLeft', 'ff52:ArrowUp', 'ff53:ArrowRight', 'ff54:ArrowDown', 'ff08:Backspace'])
  })

  it('holds the modifiers down around it, Super too', () => {
    const { rfb, sent } = keyboard()
    pressKey(rfb, 'tab', ['super'])
    expect(sent).toEqual(['ffeb↓:MetaLeft', 'ff09:Tab', 'ffeb↑:MetaLeft'])
  })
})

describe('inputChange', () => {
  it('is what was typed at the end of the hidden input', () => {
    expect(inputChange('____', '____ab')).toEqual({ backspaces: 0, text: 'ab' })
  })

  it('counts characters taken off as backspaces', () => {
    expect(inputChange('____ab', '____')).toEqual({ backspaces: 2, text: '' })
  })

  it('backspaces to where an autocorrection starts, then types it', () => {
    expect(inputChange('____teh', '____the ')).toEqual({ backspaces: 2, text: 'he ' })
  })

  it('counts an emoji as one character', () => {
    expect(inputChange('__😀', '__')).toEqual({ backspaces: 1, text: '' })
  })
})

describe('typeChange', () => {
  it('takes characters off with Backspace, then types, the modifiers held around the first key only', () => {
    const { rfb, sent } = keyboard()
    typeChange(rfb, { backspaces: 2, text: 'he' }, ['ctrl'])
    expect(sent).toEqual(['ffe3↓:ControlLeft', 'ff08:Backspace', 'ffe3↑:ControlLeft', 'ff08:Backspace', '68', '65'])
  })

  it('holds the modifiers around the typed text when nothing is taken off', () => {
    const { rfb, sent } = keyboard()
    typeChange(rfb, { backspaces: 0, text: 'c' }, ['alt'])
    expect(sent).toEqual(['ffe9↓:AltLeft', '63', 'ffe9↑:AltLeft'])
  })
})
