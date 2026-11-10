/**
 * Typing on a bot's Screen from a phone (spec: Screen and take-over → Toolbar): what the phone's keyboard typed into a
 * hidden input, the special keys and sticky modifiers of the toolbar, and pasted text, as noVNC key presses.
 */

/** As much of noVNC's client as typing needs. */
export type KeySender = { sendKey(keysym: number, code: string, down?: boolean): void }

/** The toolbar's modifiers, which stay held until the next key. */
export type Modifier = 'ctrl' | 'alt' | 'super'

/** The toolbar's special keys, plus Backspace for the hidden input. */
export type SpecialKey = 'escape' | 'tab' | 'enter' | 'left' | 'up' | 'right' | 'down' | 'backspace'

type Key = { keysym: number; code: string }

// X11 keysyms (keysymdef.h) and the DOM codes noVNC sends with them.
const modifierKeys: Record<Modifier, Key> = {
  ctrl: { keysym: 0xffe3, code: 'ControlLeft' },
  alt: { keysym: 0xffe9, code: 'AltLeft' },
  super: { keysym: 0xffeb, code: 'MetaLeft' },
}

const specialKeys: Record<SpecialKey, Key> = {
  escape: { keysym: 0xff1b, code: 'Escape' },
  tab: { keysym: 0xff09, code: 'Tab' },
  enter: { keysym: 0xff0d, code: 'Enter' },
  left: { keysym: 0xff51, code: 'ArrowLeft' },
  up: { keysym: 0xff52, code: 'ArrowUp' },
  right: { keysym: 0xff53, code: 'ArrowRight' },
  down: { keysym: 0xff54, code: 'ArrowDown' },
  backspace: { keysym: 0xff08, code: 'Backspace' },
}

/** A character's key: Latin-1 is its own keysym, anything else a Unicode keysym, as noVNC's own lookup does. */
function characterKey(character: string): Key {
  if (character === '\n' || character === '\r') return specialKeys.enter
  if (character === '\t') return specialKeys.tab
  const point = character.codePointAt(0)!
  const latin1 = (point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xff)
  return { keysym: latin1 ? point : 0x01000000 + point, code: '' }
}

function press(rfb: KeySender, key: Key, modifiers: readonly Modifier[]) {
  for (const modifier of modifiers) rfb.sendKey(modifierKeys[modifier].keysym, modifierKeys[modifier].code, true)
  rfb.sendKey(key.keysym, key.code)
  for (const modifier of [...modifiers].reverse()) rfb.sendKey(modifierKeys[modifier].keysym, modifierKeys[modifier].code, false)
}

/** Presses one of the toolbar's special keys, with `modifiers` held around it. */
export function pressKey(rfb: KeySender, key: SpecialKey, modifiers: readonly Modifier[] = []) {
  press(rfb, specialKeys[key], modifiers)
}

/** Types `text` key by key (the phone's keyboard, Paste), with `modifiers` held around the first key only. */
export function typeText(rfb: KeySender, text: string, modifiers: readonly Modifier[] = []) {
  Array.from(text).forEach((character, index) => press(rfb, characterKey(character), index === 0 ? modifiers : []))
}

/**
 * What the phone's keyboard did to the hidden input, from its value before and after (the trick from noVNC's app,
 * which keeps the input filled so Backspace always has something to take off): characters taken off from the end,
 * then text typed, so an autocorrection is undone back to where it differs and typed again.
 */
export function inputChange(previous: string, next: string): { backspaces: number; text: string } {
  const before = Array.from(previous)
  const after = Array.from(next)
  let same = 0
  while (same < before.length && same < after.length && before[same] === after[same]) same++
  return { backspaces: before.length - same, text: after.slice(same).join('') }
}

/** Types what the phone's keyboard did (see {@link inputChange}), `modifiers` held around its first key. */
export function typeChange(rfb: KeySender, { backspaces, text }: { backspaces: number; text: string }, modifiers: readonly Modifier[] = []) {
  for (let i = 0; i < backspaces; i++) pressKey(rfb, 'backspace', i === 0 ? modifiers : [])
  typeText(rfb, text, backspaces ? [] : modifiers)
}
