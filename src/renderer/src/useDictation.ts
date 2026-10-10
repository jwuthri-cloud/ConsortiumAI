import { useRef, useState } from 'react'

// Press to record, press again to stop: the clip goes through local Whisper and the text comes back.
export function useDictation(
  onText: (text: string) => void,
  onError: (message: string) => void
): { recording: boolean; transcribing: boolean; toggle: () => Promise<void> } {
  const recorder = useRef<MediaRecorder | null>(null)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const toggle = async (): Promise<void> => {
    if (recorder.current) return recorder.current.stop()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return onError(
        'No microphone access. Allow it in System Settings → Privacy & Security → Microphone.'
      )
    }
    const rec = new MediaRecorder(stream)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      recorder.current = null
      setRecording(false)
      setTranscribing(true)
      try {
        const path = await window.api!.saveFile(
          'dictation.webm',
          await new Blob(chunks).arrayBuffer()
        )
        const text = await window.api!.transcribe(path)
        if (text) onText(text)
      } catch (e) {
        onError(
          (e instanceof Error ? e.message : String(e)).replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            ''
          )
        )
      } finally {
        setTranscribing(false)
      }
    }
    rec.start()
    recorder.current = rec
    setRecording(true)
  }
  return { recording, transcribing, toggle }
}
