FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
# git is required at runtime for the workspace git-status / git-diff endpoints
# (and for the existing getAgentGitRepos dirty-status detection, which silently
# fell back to "clean" without git on PATH).
RUN apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api/package.json ./api/
RUN cd api && npm install --omit=dev
COPY api/*.js ./api/
COPY --from=build /app/dist ./dist/
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "api/api.js"]
