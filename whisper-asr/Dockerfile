FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "onnx-asr[cpu,hub]" fastapi uvicorn soundfile numpy python-multipart

# Pre-download the model at build time so startup is instant.
RUN python3 -c "import onnx_asr; onnx_asr.load_model('nemo-parakeet-tdt-0.6b-v3')"

COPY server.py .

EXPOSE 9000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9000"]
