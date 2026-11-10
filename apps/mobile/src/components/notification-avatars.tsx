import { useLive } from '@openbot/client'
import { avatarMark, avatarViewBox } from '@openbot/ui/avatar'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg from 'react-native-svg'
import { useAppActive } from '../lib/app-state.ts'
import { avatarKey, type CachedBot } from '../lib/notifications/avatar-cache.ts'
import { notificationAvatars, setAvatarDrawer } from '../lib/notifications/avatars.ts'
import { draw } from './avatar.tsx'

/**
 * The drawing's size in points, drawn at the screen's scale: iOS shows a communication notification's avatar at about
 * 40 points, so 64 leaves it sharp (192 pixels on a 3× screen).
 */
const points = 64
/** A drawing that hasn't come back by then is given up, and tried at the next sync. */
const drawTimeout = 5000

type Job = { id: number; bot: CachedBot; resolve: (png: string) => void; reject: (error: Error) => void }

/**
 * Keeps the bots' avatars for iOS's notifications current as bots come, change and go (spec: Notifications on the
 * phone → Avatar): draws each one off screen with react-native-svg, as the app shows it, at rest, into the app group,
 * where the Notification Service Extension finds it. Renders nothing where the cache doesn't exist (Android).
 */
export function NotificationAvatars() {
  return notificationAvatars ? <AvatarDrawer /> : null
}

function AvatarDrawer() {
  const live = useLive()
  const [job, setJob] = useState<Job>()
  const svg = useRef<Svg>(null)

  useEffect(() => {
    let next = 0
    setAvatarDrawer(
      (bot) =>
        new Promise<string>((resolve, reject) => {
          const id = ++next
          let settled = false
          const settle = () => {
            settled = true
            clearTimeout(timer)
            setJob((current) => (current?.id === id ? undefined : current))
          }
          const job: Job = {
            id,
            bot,
            resolve: (png) => settled || (settle(), resolve(png)),
            reject: (error) => settled || (settle(), reject(error)),
          }
          const timer = setTimeout(() => job.reject(new Error('The avatar took too long to draw')), drawTimeout)
          setJob(job)
        }),
    )
    return () => setAvatarDrawer(undefined)
  }, [])

  // Only what the drawings depend on: the bots' list changes with every run, their avatars seldom.
  const bots = live.bots
  const key = bots?.map((bot) => `${bot.id}=${avatarKey(bot)}`).join(',')
  const cached = useMemo(
    () => bots?.map(({ id, avatarStyle, avatarShape, avatarColor }): CachedBot => ({ id, avatarStyle, avatarShape, avatarColor })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` says when they change
    [key],
  )
  // Again as the app comes to the foreground, for a bot that couldn't be drawn last time.
  const active = useAppActive()
  useEffect(() => {
    if (cached && active) void notificationAvatars?.sync(cached)
  }, [cached, active])

  if (!job) return null
  const { bot } = job
  return (
    <View style={styles.offscreen} pointerEvents="none">
      <Svg
        key={job.id}
        ref={svg}
        viewBox={avatarViewBox}
        width={points}
        height={points}
        onLayout={() =>
          svg.current?.toDataURL(
            (png?: string) => (png ? job.resolve(png) : job.reject(new Error("The avatar couldn't be drawn"))),
            { width: points, height: points },
          )
        }
      >
        {avatarMark({ style: bot.avatarStyle, shape: bot.avatarShape, color: bot.avatarColor, state: 'idle', size: points, id: `cached${job.id}` }).map(draw)}
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  // Laid out, so react-native-svg can draw it, but never on screen.
  offscreen: { position: 'absolute', left: -2 * points, top: 0, width: points, height: points, opacity: 0 },
})
