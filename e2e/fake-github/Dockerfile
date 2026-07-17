# Fake GitHub server image (#710, e2e overlay only). Zero npm dependencies —
# just the Node stdlib http server — so no install step and no lockfile.
FROM node:22-slim
WORKDIR /app
COPY server.js package.json ./
ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
