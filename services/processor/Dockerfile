FROM python:3.14-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
# opentelemetry-instrument sets up the SDK from OTEL_* env and patches kafka/psycopg/boto
# before main.py imports them.
CMD ["opentelemetry-instrument", "python", "-u", "src/main.py"]
