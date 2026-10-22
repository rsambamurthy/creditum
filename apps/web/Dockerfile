# Creditum web — static build served by unprivileged nginx with a same-origin /api proxy.
# Build from the repository root:  docker build -f apps/web/Dockerfile -t creditum-web .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tools/guardrails/package.json tools/guardrails/
RUN npm ci --workspace apps/web --include-workspace-root=false
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
RUN apk upgrade --no-cache
USER 101
COPY apps/web/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENV NGINX_ENVSUBST_FILTER=API_UPSTREAM
EXPOSE 8080
