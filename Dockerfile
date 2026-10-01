FROM node:24-alpine

WORKDIR /app

RUN npm install -g npm-check-updates

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "test"]
