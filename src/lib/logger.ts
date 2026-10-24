import "server-only";
import pino, { type DestinationStream } from "pino";
import { getLogLevel } from "./env";

export function createLogger(destination?: DestinationStream) {
  const options = {
    level: getLogLevel(),
    redact: {
      paths: [
        "password", "token", "secret", "authorization", "cookie", "DATABASE_URL", "DATABASE_URL_UNPOOLED", "databaseUrl", "DD_API_KEY", "DD_APP_KEY", "apiKey", "appKey",
        "*.password", "*.token", "*.secret", "*.authorization", "*.cookie",
        "req.headers.authorization", "req.headers.cookie", 'req.headers["x-api-key"]',
      ],
      remove: true,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
