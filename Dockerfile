FROM node:24-alpine
# Basis-OS altijd naar laatste beveiligingsupdates (CVE-scan 21-10-2026)
RUN apk upgrade --no-cache

# better-sqlite3 needs a native build toolchain at install time on Alpine.
# fontconfig + dejavu: Alpine ships NO fonts at all by default -- sharp/
# librsvg would silently render the share-image's text as blank/tofu without
# these (confirmed: `Fontconfig error: Cannot load default config file`).
RUN apk add --no-cache python3 make g++ fontconfig ttf-dejavu

WORKDIR /app
COPY package.json ./
# npm itself is only needed at build time: removing it from the final image
# drops its bundled dependencies (a recurring source of scanner findings in
# code the app never runs).
RUN npm install --omit=dev && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY . .

USER node
EXPOSE 3000
CMD ["node", "server.js"]
