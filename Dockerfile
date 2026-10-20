FROM node:20-alpine

# Installa librerie necessarie per sqlite3 su Alpine
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3111

CMD ["npm", "start"]