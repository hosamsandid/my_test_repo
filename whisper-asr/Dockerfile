FROM onerahmet/openai-whisper-asr-webservice:latest

ENV ASR_MODEL=small ASR_ENGINE=faster_whisper ASR_COMPUTE_TYPE=int8

RUN /app/.venv/bin/python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', compute_type='int8')"
