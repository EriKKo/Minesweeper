FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Concatenates + minifies the client scripts into bundle.js (see scripts/build-client.js /
# staticServer.js) — needs esbuild, a devDependency, hence the full `npm install` above; prune it
# (and the other devDependencies) once the build artifact exists so the shipped image doesn't
# carry them.
RUN npm run build && npm prune --omit=dev

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server/minesweeperServer.js"]
