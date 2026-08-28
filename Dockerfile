FROM node:20-alpine AS build
WORKDIR /app
# grpc-tools' precompiled protoc/grpc_node_plugin binaries are built against
# glibc, not Alpine's musl libc — without libc6-compat, `npm run proto:gen`
# fails with "spawnSync .../grpc-tools/bin/protoc ENOENT" because the binary
# grpc-tools downloaded can't even be loaded, let alone run.
RUN apk add --no-cache libc6-compat
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run proto:gen && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# bcrypt ships prebuilt native binaries for glibc Linux, not musl — on Alpine
# it falls back to compiling from source, which needs these build tools
# present during `npm ci`. Installed as a virtual package and removed
# immediately after so they don't bloat the final image.
RUN apk add --no-cache --virtual .build-deps make gcc g++ python3
COPY package*.json ./
RUN npm ci --omit=dev && apk del .build-deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/libs/proto/src ./libs/proto/src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/apps/api/src/main.js"]
