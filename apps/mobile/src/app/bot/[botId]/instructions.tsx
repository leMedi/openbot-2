import { type BotInfo, maxBotInstructionsLength } from '@openbot/api-contract'
import { useLive } from '@openbot/client'
import { Stack, useLocalSearchParams } from 'expo-router'
import { FieldRow, Group, GroupedScroll, Loading, Note } from '../../../components/grouped.tsx'
import { statusNote, useBotSave, useBotText } from '../../../lib/bot-save.ts'

/** A bot's instructions, pushed from its info screen: who the bot is and how it behaves, saved as the owner types. */
export default function Instructions() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const live = useLive()
  const bot = live.bots?.find((each) => each.id === botId)
  return (
    <>
      <Stack.Screen options={{ title: 'Instructions' }} />
      {bot ? <Editor bot={bot} /> : <GroupedScroll>{live.bots ? <Note>{"This bot doesn't exist any more."}</Note> : <Loading />}</GroupedScroll>}
    </>
  )
}

function Editor({ bot }: { bot: BotInfo }) {
  const { status, save } = useBotSave(bot.id)
  const instructions = useBotText(bot, 'instructions', save)
  return (
    <GroupedScroll>
      <Group note={statusNote(status, `Who ${bot.name} is and how it behaves. Changes save as you type, and apply from its next run.`)}>
        <FieldRow
          accessibilityLabel="Instructions"
          value={instructions.text}
          onChangeText={instructions.change}
          onEndEditing={instructions.leave}
          maxLength={maxBotInstructionsLength}
          placeholder="A calm release engineer who fixes builds and explains what went wrong in plain words."
          multiline
          style={{ minHeight: 260, lineHeight: 22 }}
        />
      </Group>
    </GroupedScroll>
  )
}
