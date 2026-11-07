# The optional background service of the copypaste plugin. Build from the repository root:
#   docker build -f server/Dockerfile -t copypaste-jobs .
FROM node:22-slim
WORKDIR /app
# the service runs the plugin's own engine: same file, so the two can never drift apart
COPY src/engine.js ./src/engine.js
COPY server/copyjobs.mjs ./server/copyjobs.mjs
ENV NODE_ENV=production STATE_DIR=/state PORT=8335
RUN mkdir /state && chown node:node /state
VOLUME /state
USER node
EXPOSE 8335
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/copyjobs.mjs"]
