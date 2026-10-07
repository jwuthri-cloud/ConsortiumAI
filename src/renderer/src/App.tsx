import { useEffect, useReducer } from 'react'
import { initial, reducer } from './state'
import Convene from './Convene'
import Chamber from './Chamber'
import Consortium from './Consortium'

export default function App(): React.JSX.Element {
  const [s, dispatch] = useReducer(reducer, initial)
  useEffect(() => window.api!.onEvent(dispatch), [])
  // the moment: the rim closes in the chamber, then the document rises
  useEffect(() => {
    if (s.stage === 'done' && s.screen === 'chamber' && s.consortium && !s.revealed) {
      const t = setTimeout(() => dispatch({ type: 'show-consortium' }), 1800)
      return () => clearTimeout(t)
    }
    return undefined
  }, [s.stage, s.screen, s.consortium, s.revealed])

  if (s.screen === 'convene')
    return (
      <Convene
        onStart={(brief) => {
          const sessionId = crypto.randomUUID()
          dispatch({ type: 'convene', brief, sessionId })
          void window.api!.start(brief, sessionId)
        }}
        onOpen={(session) => dispatch({ type: 'open', session })}
      />
    )
  if (s.screen === 'consortium' && s.consortium && s.brief)
    return (
      <Consortium
        state={s}
        onHome={() => dispatch({ type: 'home' })}
        onChamber={() => dispatch({ type: 'show-chamber' })}
      />
    )
  return (
    <Chamber
      state={s}
      onHome={() => dispatch({ type: 'home' })}
      onConsortium={() => dispatch({ type: 'show-consortium' })}
    />
  )
}
