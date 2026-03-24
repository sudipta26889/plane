FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

EXPOSE 4650

CMD ["node", "dist/index.js"]
