FROM node:24.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium socat fonts-noto-cjk fonts-liberation git zip python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/web
RUN npm init -y && npm install --save-exact vite@7.3.1 react@19.2.4 react-dom@19.2.4 vite-plugin-singlefile@2.3.0
ENV PATH=/opt/web/node_modules/.bin:$PATH NODE_PATH=/opt/web/node_modules
USER node
WORKDIR /workspace
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["chromium --headless --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/tmp/chromium about:blank >/tmp/chromium.log 2>&1 & exec sleep infinity"]
