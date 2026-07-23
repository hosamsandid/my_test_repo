FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg wget bzip2 && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir sherpa-onnx fastapi uvicorn soundfile numpy

RUN mkdir -p /app/models && \
    wget -q -O /tmp/model.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 && \
    tar xf /tmp/model.tar.bz2 -C /app/models && \
    rm /tmp/model.tar.bz2

COPY server.py .

EXPOSE 9000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9000"]
