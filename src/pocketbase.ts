import PocketBase from 'pocketbase';

const defaultPocketBaseUrl = "https://sn-pb-repo-1292607600-93600e.fly.dev";
const pocketBaseUrl = (import.meta as ImportMeta & {
  env: { VITE_POCKETBASE_URL?: string };
}).env.VITE_POCKETBASE_URL || defaultPocketBaseUrl;

if (!pocketBaseUrl) {
  throw new Error('VITE_POCKETBASE_URL is required.');
}

export const pb = new PocketBase(pocketBaseUrl);
export const apiBaseUrl = pocketBaseUrl;
