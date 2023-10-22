import * as fs from "fs/promises";

import { Deferred } from "./deferred.js";

type EmbeddingMetadata = {
  eventIds: number[];
};

type EmbeddingDB = {
  [key: string]: {
    embeddings: number[];
    metadata: EmbeddingMetadata;
  };
};

let embeddingDB: EmbeddingDB = {};

const DB_PATH = "./embeddings.json";
const DB_PATH_BACKUP = "./embeddings.json.backup";

export async function loadEmbeddings(tryLoadFromBackup: boolean = true) {
  try {
    const data = await fs.readFile(DB_PATH, "utf-8");
    embeddingDB = JSON.parse(data);
  } catch (err) {
    if (!tryLoadFromBackup) throw err;
    // Might be data corruption, restore from backup
    await fs.copyFile(DB_PATH_BACKUP, DB_PATH);
    await loadEmbeddings(false);
  }
}

export async function flushEmbeddings() {
  // Copy current file to backup
  await fs.copyFile(DB_PATH, DB_PATH_BACKUP);
  await fs.writeFile(DB_PATH, JSON.stringify(embeddingDB));
}

export function upsertEmbedding(key: string, embeddings: number[], metadata: EmbeddingMetadata) {
  if (embeddingDB[key]) {
    embeddingDB[key].metadata.eventIds = [
      ...new Set([...embeddingDB[key].metadata.eventIds, ...metadata.eventIds])
    ];
  } else {
    embeddingDB[key] = {
      embeddings,
      metadata
    };
  }
}

export function deleteEmbedding(key: string) {
  delete embeddingDB[key];
}

export function getEmbedding(
  key: string
): { embeddings: number[]; metadata: EmbeddingMetadata } | undefined {
  return embeddingDB[key];
}

export function getDistance(embeddings1: number[], embeddings2: number[]) {
  let distance = 0;
  for (let i = 0; i < embeddings1.length; i++) {
    distance += (embeddings1[i] - embeddings2[i]) ** 2;
  }
  return distance;
}

export function getKNearestNeighbors(target: number[], k: number = 1) {
  const distances: [string, number][] = [];
  for (const key of Object.keys(embeddingDB)) {
    const { embeddings } = embeddingDB[key];
    distances.push([key, getDistance(target, embeddings)]);
  }
  distances.sort((a, b) => a[1] - b[1]);
  return distances.slice(0, k);
}

const waiters: (Deferred<void> | undefined)[] = [];

export async function acquireLock() {
  if (waiters.length == 0) {
    waiters.push(undefined);
    return;
  }
  // need to push Deferred if there are other waiters waiting in the line / no waiters but someone is using it
  const deferred = new Deferred<void>();
  waiters.push(deferred);
  await deferred;
}

export function releaseLock() {
  // waiters.length == 0: only I am using it and nobody else is waiting
  if (waiters[0] === undefined) waiters.shift();
  if (waiters.length == 0) return;
  const deferred = waiters.shift()!;
  deferred.resolve();
}
