# Paper bot image. Build from the repo root:  docker build -f bot/Dockerfile -t voltrak-bot .
FROM node:22-alpine
WORKDIR /app
COPY engine ./engine
COPY bot ./bot
ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s CMD wget -qO- http://localhost:8080/health || exit 1
USER node
CMD ["node", "bot/bin/run.mjs"]
