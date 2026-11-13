FROM node:24-alpine
WORKDIR /app
COPY package.json server.ts ./
ENV NODE_ENV=production
EXPOSE 3100 2525
CMD ["node", "server.ts"]
