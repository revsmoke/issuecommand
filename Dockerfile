FROM oven/bun:1.3.8-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun tsconfig.json ./tsconfig.json
COPY --chown=bun:bun README.md ./README.md

ENV NODE_ENV=production
ENV HTTP_PORT=3100
ENV STATE_FILE_PATH=/app/data/issuecommand-state.json

VOLUME ["/app/data"]

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const p=process.env.HTTP_PORT||3100;const k=process.env.API_KEY||'';fetch('http://127.0.0.1:'+p+'/api/health',{headers:{Authorization:'Bearer '+k}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"

USER bun

CMD ["bun", "run", "src/index.ts"]
