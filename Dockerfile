FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ai.js mail.js ./
COPY dist ./dist
COPY data ./data

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
