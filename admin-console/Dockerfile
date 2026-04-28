FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY api/package.json ./api/
RUN cd api && npm install --omit=dev
COPY api/api.js ./api/
COPY --from=build /app/dist ./dist/
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "api/api.js"]
