import type { BotInfo } from '@openbot/api-contract'
import { describe, expect, it } from 'vitest'
import { groupCandidates } from './groups.ts'

const bot = (name: string): BotInfo => ({
  id: name.toLowerCase(),
  name,
  title: null,
  instructions: '',
  avatarStyle: 'critter',
  avatarShape: 'blob',
  avatarColor: 'blue',
  model: null,
  chatId: `dm-${name.toLowerCase()}`,
  working: false,
  error: null,
})

const team = ['Rex', 'Ana', 'Maya', 'Iris', 'Otto', 'Noor', 'Lena'].map(bot)
const names = (bots: BotInfo[]) => bots.map((each) => each.name)

describe('the bots a group chat can take', () => {
  it('offers every bot not in it yet, matching what was typed anywhere in the name, ignoring case and a leading @', () => {
    expect(names(groupCandidates(team, [team[0]!], ''))).toEqual(['Ana', 'Maya', 'Iris', 'Otto', 'Noor', 'Lena'])
    expect(names(groupCandidates(team, [], '@A'))).toEqual(['Ana', 'Maya', 'Lena'])
    expect(names(groupCandidates(team, [], ' ir '))).toEqual(['Iris'])
  })

  it('offers none once the group has the most members it can have', () => {
    expect(groupCandidates(team, team.slice(0, 6), '')).toEqual([])
  })
})
