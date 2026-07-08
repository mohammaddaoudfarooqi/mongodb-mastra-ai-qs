FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Run as a non-root user and move nginx's pid file to /tmp so the container works
# on a read-only root filesystem (mirrors frontend/Dockerfile.k8s). Port 3000 is
# unprivileged, so the non-root bind succeeds.
RUN adduser -D -u 1000 appuser && \
    chown -R appuser:appuser /usr/share/nginx/html /var/cache/nginx /var/log/nginx && \
    sed -i 's|/run/nginx.pid|/tmp/nginx.pid|' /etc/nginx/nginx.conf
USER appuser

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
