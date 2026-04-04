FROM denoland/deno:bin-2.2.11 AS deno

FROM node:22.14-bookworm-slim
COPY --from=deno /deno /usr/local/bin/deno

WORKDIR /app

COPY package.json deno.json ./
RUN deno task install

COPY src ./src

RUN mkdir -p /app/vault

ENV FILESYNC_VAULT_DIR=/app/vault

CMD ["deno", "task", "main"]
