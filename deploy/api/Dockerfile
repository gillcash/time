FROM node:22-alpine

RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY server.js time-schema.js time-auth.js time-routes.js notification-engine.js ./

EXPOSE 3400

CMD ["node", "server.js"]
