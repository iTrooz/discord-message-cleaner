FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY bot.js logger.js ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["npm", "run", "start"]
