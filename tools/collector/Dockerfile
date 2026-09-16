# Build from repository root:
# docker build -f tools/collector/Dockerfile -t guoxiaoshao-collector:0.2.0 .
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 GXS_ENABLE_COLLECTOR_PROCESS=false
WORKDIR /app/tools/collector
COPY tools/collector/package.json tools/collector/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY cloudfunctions/gxs_api/lib /app/cloudfunctions/gxs_api/lib
COPY tools/collector/runner.js ./runner.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "runner.js"]
