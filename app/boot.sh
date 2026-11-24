#!/bin/sh
set -eu
install -d -m 0700 -o node -g node /data/state /data/library /data/workspace
export HOME=/home/node
cd /app
exec runuser -u node --preserve-environment -- node /opt/railway/server.mjs
