FROM searxng/searxng:latest@sha256:a7fc607aa6723f5a8982105bcc5ffba4d1b9fc7c6922a31a88d6e4cba49ef12a
COPY settings.yml /etc/searxng/settings.yml
ENV SEARXNG_BIND_ADDRESS=:: SEARXNG_PORT=8080
EXPOSE 8080
