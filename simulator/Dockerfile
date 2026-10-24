FROM node:24-alpine
WORKDIR /sim
COPY package.json ./
COPY src ./src
USER node
CMD ["node", "src/cli.mjs", "run"]
