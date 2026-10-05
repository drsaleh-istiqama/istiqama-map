# Edge Functions server for the Railway deployment (see docs/DEPLOY_RAILWAY.md).
# Build context: repository root.  Railway: Dockerfile path = deploy/functions/Dockerfile.

# The template's credential wrapper: derives JWT_SECRET, SUPABASE_JWKS, SUPABASE_ANON_KEY and
# SUPABASE_SERVICE_ROLE_KEY from ROOT_SECRET (same code the other Supabase services run), so no
# key is ever copied into a Railway variable.
FROM golang:1.26-alpine AS secrets
ARG SUPABASE_SECRETS_VERSION=main
RUN CGO_ENABLED=0 GOBIN=/out \
    go install github.com/6ixfalls/supabase/secrets/cmd/supabase-secrets@${SUPABASE_SECRETS_VERSION}

FROM node:24-slim
ENV NODE_ENV=production PORT=9000
WORKDIR /app

COPY deploy/functions/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY supabase/functions ./supabase/functions
COPY scripts/local-stack/gateway/functions.ts scripts/local-stack/gateway/http.ts \
     scripts/local-stack/gateway/jwt.ts scripts/local-stack/gateway/log.ts \
     scripts/local-stack/gateway/config.ts ./scripts/local-stack/gateway/
COPY deploy/functions/server.ts ./deploy/functions/server.ts

COPY --from=secrets --chmod=755 /out/supabase-secrets /usr/local/bin/supabase-secrets

USER node
EXPOSE 9000
ENTRYPOINT ["/usr/local/bin/supabase-secrets", "--service", "functions", "--"]
CMD ["node", "--import", "tsx", "deploy/functions/server.ts"]
