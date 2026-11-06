import { useId } from 'react'

/** Where the bot rides on the ring: the top right (−45°) of a 32-unit ring centred in the 100-unit box. */
const CX = 50 + 32 * Math.cos(-Math.PI / 4)
const CY = 50 + 32 * Math.sin(-Math.PI / 4)

/**
 * OpenBot's mark (Orbit): an O drawn as a ring, with a core, and a bot riding the ring. It is drawn in `currentColor`
 * and its cut-outs are masks, so it sits on any background. Below 24px it switches to a bolder cut (thicker ring,
 * bigger bot, no core), as the favicon does. The same mark is in `docs/brand/` and `public/favicon.svg`.
 *
 * Its parts carry `data-part` for animation: `ring`, `core`, `rider` (the bot and the gap it cuts in the ring; rotate
 * every `rider` about the centre, 50 50, to send the bot round), `bot` (counter-rotate it to keep the bot upright) and
 * `eye`.
 */
export function OpenBotMark({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  const id = useId()
  const small = size < 24
  const [stroke, w, h] = small ? [11, 26, 23] : [8, 22, 19.5]
  const gap = 3.5
  const radius = w * 0.34
  const eye = { width: w * 0.15, height: h * 0.48, rx: w * 0.075, y: CY - h * 0.24 }
  const origin = { transformOrigin: '50px 50px' }
  const botOrigin = { transformOrigin: `${CX}px ${CY}px`, transformBox: 'view-box' as const }
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <mask id={`${id}-ring`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <g data-part="rider" style={origin}>
            <rect x={CX - w / 2 - gap} y={CY - h / 2 - gap} width={w + gap * 2} height={h + gap * 2} rx={radius + gap} />
          </g>
        </mask>
        <mask id={`${id}-bot`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <g data-part="rider" style={origin}>
            <g data-part="bot" style={botOrigin}>
              <rect data-part="eye" x={CX - w * 0.24} {...eye} />
              <rect data-part="eye" x={CX + w * 0.09} {...eye} />
            </g>
          </g>
        </mask>
      </defs>
      <g fill="currentColor">
        <g mask={`url(#${id}-ring)`}>
          <circle data-part="ring" cx="50" cy="50" r="32" fill="none" stroke="currentColor" strokeWidth={stroke} />
          {!small && <circle data-part="core" cx="50" cy="50" r="6" />}
        </g>
        <g data-part="rider" style={origin}>
          <g data-part="bot" style={botOrigin}>
            <rect x={CX - w / 2} y={CY - h / 2} width={w} height={h} rx={radius} mask={`url(#${id}-bot)`} />
          </g>
        </g>
      </g>
    </svg>
  )
}
