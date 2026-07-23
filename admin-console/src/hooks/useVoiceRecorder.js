// React is a browser/bundler dependency; import gracefully so node:test can
// load this module to test the pure `transcribeAudio` helper without React.
let useState, useRef, useCallback, useEffect;
try {
  ({ useState, useRef, useCallback, useEffect } = await import('react'));
} catch {
  // Non-browser environment (e.g. node:test); React hooks are unavailable.
}

/** POST a recorded blob to /api/transcribe, return the text. */
export async function transcribeAudio(blob, fetchFn = globalThis.fetch) {
  const form = new FormData();
  form.append('audio_file', blob, 'recording.webm');
  const res = await fetchFn('/api/transcribe', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Transcription failed');
  const data = await res.json();
  return data.text || '';
}

/**
 * Hook managing the mic → record → transcribe lifecycle.
 * Returns { state, elapsedSeconds, error, toggleRecording, clearError }.
 */
export default function useVoiceRecorder({ onTranscription }) {
  const [state, setState] = useState('idle');        // 'idle' | 'recording' | 'transcribing'
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState(null);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current);
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    recorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone blocked — click the lock icon in your address bar to allow it, then try again.');
      return;
    }

    streamRef.current = stream;
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;

    recorder.ondataavailable = async (e) => {
      // Stop all tracks to release the mic.
      stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;

      if (!e.data || e.data.size === 0) {
        setState('idle');
        return;
      }

      setState('transcribing');
      try {
        const text = await transcribeAudio(e.data);
        if (text) onTranscription?.(text);
      } catch {
        setError('Transcription failed — please try again.');
      }
      setState('idle');
    };

    recorder.start();
    setState('recording');
    setElapsedSeconds(0);
    timerRef.current = setInterval(() => {
      setElapsedSeconds(s => s + 1);
    }, 1000);
  }, [onTranscription]);

  const toggleRecording = useCallback(() => {
    if (state === 'recording') {
      stopRecording();
    } else if (state === 'idle') {
      startRecording();
    }
    // ignore clicks during 'transcribing'
  }, [state, startRecording, stopRecording]);

  return { state, elapsedSeconds, error, toggleRecording, clearError };
}
