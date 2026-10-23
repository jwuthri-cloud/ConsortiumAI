import { useEffect, useReducer, useRef } from 'react'
import { initial, reducer } from './state'
import * as voice from './voice'
import Convene from './Convene'
import Chamber from './Chamber'
import Consortium from './Consortium'

export default function App(): React.JSX.Element {
  const [s, dispatch] = useReducer(reducer, initial)
  const screen = useRef(s.screen)
  useEffect(
    () =>
      window.api!.onEvent((e) => {
        // audio goes to the player, not the state; the lobby stays silent (and acks, so nothing waits)
        if (e.type === 'voice') return voice.play(e, screen.current !== 'convene')
        if (e.type === 'human-priority') voice.cut()
        if (e.type === 'stopped' || e.type === 'failed') voice.stop()
        if (e.type === 'turn-start') voice.turnStarted(e.turn)
        dispatch(e)
      }),
    []
  )
  useEffect(() => {
    screen.current = s.screen
    if (s.screen === 'convene') voice.stop()
  }, [s.screen])
  if (s.screen === 'convene')
    return (
      <Convene
        onStart={(brief) => {
          voice.reset()
          const sessionId = crypto.randomUUID()
          dispatch({ type: 'convene', brief, sessionId })
          void window.api!.start(brief, sessionId)
        }}
        onOpen={(session) => dispatch({ type: 'open', session })}
        onContinue={(session) => {
          voice.reset()
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
