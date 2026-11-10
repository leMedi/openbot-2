import { describe, expect, it } from 'vitest'
import { heardText, insertDictation } from './text.ts'

describe('putting dictated text in the draft', () => {
  it('fills an empty draft and leaves the cursor after it', () => {
    expect(insertDictation('', { start: 0, end: 0 }, 'Book a table for two.')).toEqual({ text: 'Book a table for two.', cursor: 21 })
  })

  it('adds a space before it after a word', () => {
    expect(insertDictation('Hi Rex,', { start: 7, end: 7 }, 'can you check the flights?')).toEqual({
      text: 'Hi Rex, can you check the flights?',
      cursor: 34,
    })
  })

  it('goes in at the cursor mid-draft, spaced from the words on both sides', () => {
    expect(insertDictation('Call tomorrow', { start: 4, end: 4 }, 'the dentist')).toEqual({ text: 'Call the dentist tomorrow', cursor: 16 })
  })

  it('adds a space after it at the start of a draft', () => {
    expect(insertDictation('tomorrow at nine', { start: 0, end: 0 }, 'Call the dentist')).toEqual({ text: 'Call the dentist tomorrow at nine', cursor: 17 })
  })

  it('replaces what is selected', () => {
    expect(insertDictation('Meet at noon.', { start: 8, end: 12 }, 'three')).toEqual({ text: 'Meet at three.', cursor: 13 })
  })

  it('adds no space after a trailing space or before punctuation', () => {
    expect(insertDictation('Note: ', { start: 6, end: 6 }, 'milk')).toEqual({ text: 'Note: milk', cursor: 10 })
    expect(insertDictation('Buy !', { start: 4, end: 4 }, 'milk')).toEqual({ text: 'Buy milk!', cursor: 8 })
  })
})

describe('what was heard', () => {
  it('is the transcript, trimmed', () => {
    expect(heardText('  Remind me to call Ana.\n')).toBe('Remind me to call Ana.')
  })

  it('is nothing for silence or the engine’s non-speech markers', () => {
    expect(heardText('')).toBe('')
    expect(heardText('   ')).toBe('')
    expect(heardText('[BLANK_AUDIO]')).toBe('')
    expect(heardText(' (silence) [Music] ')).toBe('')
  })

  it('keeps the words around a marker, single-spaced', () => {
    expect(heardText('Send it [inaudible] tomorrow')).toBe('Send it tomorrow')
  })
})
