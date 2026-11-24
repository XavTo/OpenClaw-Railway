FROM ghcr.io/openclaw/openclaw:2026.11.8-browser@sha256:23ed6765792c3ea5e3f5199620e4072979a8deb038757b02303b105b00bbfedb
USER root
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra && rm -rf /var/lib/apt/lists/*
COPY app /opt/railway
RUN chmod 755 /opt/railway/boot.sh
ENV OPENCLAW_STATE_DIR=/data/state OPENCLAW_CONFIG_PATH=/data/state/openclaw.json
EXPOSE 8080
ENTRYPOINT ["tini", "--", "/opt/railway/boot.sh"]
CMD []
