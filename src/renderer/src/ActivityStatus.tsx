import { useEffect, useState } from 'react'
import { ACTIVITY_HINTS, ACTIVITY_LABELS } from '@shared/activity'
import type { ActivityState } from './state'

export default function ActivityStatus({
  activity,
  next
}: {
  activity: ActivityState
  next?: string
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - activity.startedAt) / 1000))
  const quiet = Math.max(0, Math.floor((now - activity.updatedAt) / 1000))
  const time =
    elapsed < 60
      ? `${elapsed}s`
      : `${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`
  return (
    <div className="activity-status">
      <div className="activity-status-line">
        <span className="working-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span role="status">{ACTIVITY_LABELS[activity.kind]}</span>
        <span className="activity-elapsed" title="Elapsed time for this turn">
          {time}
        </span>
        {next && (
          <span className="activity-next">
            Up next <b>{next}</b>
          </span>
        )}
      </div>
      <p className="activity-hint">
        {quiet >= 25
          ? `No new update from the agent for ${quiet}s. ${activity.turn === 0 ? 'You can end the session from the toolbar.' : 'You can still add a thought or end the session.'}`
          : ACTIVITY_HINTS[activity.kind]}
      </p>
    </div>
  )
}
