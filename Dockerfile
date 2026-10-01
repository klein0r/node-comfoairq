FROM node:24-alpine

WORKDIR /app

# git is needed for `npm version` (commit + tag) on the mounted repo
RUN apk add --no-cache git \
    && git config --system --add safe.directory /app

RUN npm install -g npm-check-updates

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "test"]
