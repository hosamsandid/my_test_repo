FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# Git metadata isn't available in this build context (context root is
# admin-console/, not the repo root with .git) - the caller (Makefile)
# resolves the commit/dirty state on the host and passes it in as build args.
ARG GIT_COMMIT=unknown
ARG GIT_DIRTY=""
ARG GIT_COMMIT_TIME=""
ENV VITE_GIT_COMMIT=$GIT_COMMIT
ENV VITE_GIT_DIRTY=$GIT_DIRTY
# Contributors list (#1742): the raw `%aN\t%aE` git-log lines, base64-encoded on
# the host (git is likewise unavailable here). vite.config.js decodes + extracts.
ARG GIT_CONTRIBUTORS=""
ENV VITE_CONTRIBUTORS_RAW=$GIT_CONTRIBUTORS
ENV VITE_GIT_COMMIT_TIME=$GIT_COMMIT_TIME
RUN npm run build

FROM node:22-slim
# git is required at runtime for the workspace git-status / git-diff endpoints
# (and for the existing getAgentGitRepos dirty-status detection, which silently
# fell back to "clean" without git on PATH).
RUN apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends git ca-certificates zip unzip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api/package.json ./api/
RUN cd api && npm install --omit=dev
COPY api/*.js ./api/
# Flow Copilot grounding docs (#1068): the conventions addendum plus the
# vendored copy of docs/process-template-format.md (the repo-root original is
# outside this build context; a parity test keeps the copy byte-identical).
COPY api/*.md ./api/
# Helper Chat (#1734/#1735): the api/ tree gained its first subdirectory. The
# flat api/*.js / api/*.md globs above don't recurse, so this package (handler +
# corpus/tour .js, system-prompt.md, tour-manifest.json and the docs/ corpus)
# must be copied explicitly or api.js crash-loops on `require('./helper-chat/handler')`.
COPY api/helper-chat ./api/helper-chat
COPY --from=build /app/dist ./dist/
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "api/api.js"]
