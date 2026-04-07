import { Redis as IORedis } from "ioredis";

const url = process.env.REDIS_URL;
if (!url) throw new Error("REDIS_URL is not set");

export const redis = new IORedis(url, { maxRetriesPerRequest: null });
