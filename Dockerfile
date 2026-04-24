FROM node:22-alpine

RUN apk add --no-cache sqlite libnotify
RUN npm install -g @openai/codex@0.121.0

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3188
ENV CODEX_HOME=/codex-home

EXPOSE 3188

CMD ["node", "server.js"]
