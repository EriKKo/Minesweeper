FROM node:24-alpine

# esbuild (used by `npm run build` below to bundle the client) ships a glibc-linked native binary;
# Alpine's musl libc can't run it without this compatibility shim — without it the build step fails
# with "exit code 126" (found the binary, couldn't execute it).
RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Concatenates + minifies the client scripts into bundle.js (see scripts/build-client.js /
# staticServer.js). esbuild is a real (non-dev) dependency specifically so this works with the
# plain --omit=dev install above — playwright (devDependencies-only; used solely by the manual,
# local scripts/build-mode-previews.js, whose output is committed) never needs to be installed here.
RUN npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server/minesweeperServer.js"]
