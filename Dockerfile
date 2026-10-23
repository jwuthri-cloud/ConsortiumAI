# The hosted Slack app (README, "Hosted"); with SLACK_BOT_TOKEN/SLACK_APP_TOKEN instead, the
# single-workspace Socket Mode bridge on Deep-agent seats.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production CONSORTIUM_DATA=/data PORT=3000
COPY package.json package-lock.json ./
# no install scripts: they rebuild the desktop app's native modules. The bridge never runs inside
# Electron; paths.ts and keys.ts only check for it, so a stub stands in for the package.
RUN npm ci --omit=dev --ignore-scripts && npm install -g tsx@4.23.15 && npm cache clean --force \
  && mkdir -p node_modules/electron && echo 'module.exports = {}' > node_modules/electron/index.js \
  && mkdir -p /data && chown node /data
COPY tsconfig*.json ./
COPY src ./src
USER node
VOLUME /data
EXPOSE 3000
CMD ["tsx", "src/main/slack.ts"]
