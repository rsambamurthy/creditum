# Core banking simulator — build and test environments only (fictional data). Never deployed to a bank.
# Build from the repository root:  docker build -f apps/corebank-sim/Dockerfile -t creditum-corebank-sim .
FROM node:22-alpine
ENV NODE_ENV=production
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && apk upgrade --no-cache
WORKDIR /app
COPY apps/corebank-sim/package.json ./package.json
COPY apps/corebank-sim/src ./src
COPY apps/corebank-sim/data ./data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "src/server.js"]
