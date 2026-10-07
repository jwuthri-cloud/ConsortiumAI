import { useEffect, useReducer } from 'react'
import { initial, reducer } from './state'
import Convene from './Convene'
import Chamber from './Chamber'
import Consortium from './Consortium'

export default function App(): React.JSX.Element {
  const [s, dispatch] = useReducer(reducer, initial)
  useEffect(() => window.api!.onEvent(dispatch), [])
  if (s.screen === 'convene')
    return (
      <Convene
        onStart={(brief) => {
          const sessionId = crypto.randomUUID()
          dispatch({ type: 'convene', brief, sessionId })
          void window.api!.start(brief, sessionId)
        }}
        onOpen={(session) => dispatch({ type: 'open', session })}
        onContinue={(session) => {
          dispatch({ type: 'open', session })
          dispatch({ type: 'resume' })
          void window.api!.resume(session.id)
        }}
      />
    )
  if (s.screen === 'consortium' && s.consortium && s.brief)
    return (
      <Consortium
        state={s}
        onHome={() => dispatch({ type: 'home' })}
        onChamber={(turn) => dispatch({ type: 'show-chamber', turn })}
      />
    )
  return (
    <Chamber
      state={s}
      onHome={() => dispatch({ type: 'home' })}
      onConsortium={() => dispatch({ type: 'show-consortium' })}
      onResume={() => {
        dispatch({ type: 'resume' })
        void window.api!.resume(s.sessionId!)
      }}
    />
  )
}
