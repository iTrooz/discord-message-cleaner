FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY bot.js logger.js ./
CMD ["npm", "run", "start"]
