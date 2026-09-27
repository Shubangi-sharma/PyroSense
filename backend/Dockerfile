# PYROSENSE backend — standalone deployable image
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Seed facility master list — startup bootstrap loads it into SQLite so a
# fresh deploy serves a non-empty catalogue (user_facilities.csv only;
# the 200 MB dev *.db stays excluded via .dockerignore).
COPY data/user_facilities.csv ./data/user_facilities.csv
# DATABASE_URL should point at a mounted volume in production, e.g.
#   -e DATABASE_URL=/data/pyrosense.db -v pyrosense-data:/data
EXPOSE 4000
CMD ["node", "dist/server.js"]
