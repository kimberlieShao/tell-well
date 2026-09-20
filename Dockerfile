# The public demo. One container, one process: check-in sessions and the demo switch live in that
# process's memory, so run exactly one instance (see railway.json).
FROM node:24-slim
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/
RUN npm ci --prefix backend
COPY --chown=node:node . .
# Snapshot of real WHOOP nights, example person on by default with the switch and saved check-ins kept per
# visitor (cookie), HTTPS proxy in front.
# Secrets (GEMINI_API_KEY, ELEVENLABS_API_KEY) are set on the platform, never here. PORT comes from the platform.
ENV NODE_ENV=production HOST=0.0.0.0 WEARABLE_MODE=snapshot DEMO_DEFAULT=on VISITOR_STATE=cookie TRUST_PROXY=1 CHECKIN_DAILY_TOTAL=200 TZ=America/New_York
USER node
WORKDIR /app/backend
CMD ["node", "--import", "tsx", "src/server.ts"]
