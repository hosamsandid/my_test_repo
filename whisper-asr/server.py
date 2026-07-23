import io
import subprocess
import tempfile

import numpy as np
import sherpa_onnx
import soundfile as sf
from fastapi import FastAPI, File, UploadFile

MODEL_DIR = "/app/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"

recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f"{MODEL_DIR}/encoder.int8.onnx",
    decoder=f"{MODEL_DIR}/decoder.int8.onnx",
    joiner=f"{MODEL_DIR}/joiner.int8.onnx",
    tokens=f"{MODEL_DIR}/tokens.txt",
    num_threads=4,
    sample_rate=16000,
    feature_dim=80,
    decoding_method="greedy_search",
)

app = FastAPI()


def _decode_audio(raw: bytes) -> tuple[np.ndarray, int]:
    """Decode audio bytes to float32 numpy array + sample rate.

    Tries soundfile first (WAV, FLAC, OGG).  Falls back to ffmpeg for
    formats soundfile can't handle (WebM/Opus from the browser's
    MediaRecorder).
    """
    try:
        audio, sr = sf.read(io.BytesIO(raw), dtype="float32")
        return audio, sr
    except Exception:
        pass

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=True) as tmp:
        tmp.write(raw)
        tmp.flush()
        result = subprocess.run(
            [
                "ffmpeg", "-i", tmp.name,
                "-ar", "16000", "-ac", "1", "-f", "wav", "-",
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr.decode()}")
        audio, sr = sf.read(io.BytesIO(result.stdout), dtype="float32")
        return audio, sr


def _resample(audio: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    """Resample by linear interpolation (good enough for speech)."""
    if orig_sr == target_sr:
        return audio
    ratio = target_sr / orig_sr
    n_samples = int(len(audio) * ratio)
    indices = np.linspace(0, len(audio) - 1, n_samples)
    return np.interp(indices, np.arange(len(audio)), audio).astype(np.float32)


@app.post("/asr")
async def transcribe(audio_file: UploadFile = File(...)):
    raw = await audio_file.read()
    audio, sr = _decode_audio(raw)

    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    audio = _resample(audio, sr, 16000)

    stream = recognizer.create_stream()
    stream.accept_waveform(16000, audio.tolist())
    recognizer.decode_stream(stream)

    return {"text": stream.result.text.strip()}
