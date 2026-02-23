FROM node:20-slim

WORKDIR /workspace

RUN apt-get update -y \
  && apt-get install -y openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY patches ./patches
COPY nx.json tsconfig.base.json ./
COPY apps ./apps
COPY libs ./libs

RUN npm ci
RUN npx nx build frontend --configuration=production

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npx", "nx", "start", "frontend", "--configuration=production"]
