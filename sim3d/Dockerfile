FROM python:3.14-slim

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/sim3d

WORKDIR /app

COPY sim3d/requirements.txt /app/sim3d/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/sim3d/requirements.txt

COPY sim3d /app/sim3d

VOLUME ["/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "from urllib.request import urlopen; urlopen('http://127.0.0.1:8788/health', timeout=3)"

CMD ["python", "-m", "forge_sim.service", "--host", "0.0.0.0", "--port", "8788", "--checkpoints", "/data/checkpoints", "--train"]
