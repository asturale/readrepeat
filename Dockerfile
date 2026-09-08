FROM node:22-alpine

# better-sqlite3 needs a native build toolchain at install time on Alpine.
# fontconfig + dejavu: Alpine ships NO fonts at all by default -- sharp/
# librsvg would silently render the share-image's text as blank/tofu without
# these (confirmed: `Fontconfig error: Cannot load default config file`).
RUN apk add --no-cache python3 make g++ fontconfig ttf-dejavu

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

USER node
EXPOSE 3000
CMD ["node", "server.js"]
