import * as fs from "fs/promises";

import { Deferred } from "./deferred.js";

/**
 * Metadata associated with an embedding, containing the list of event IDs
 * that are linked to a particular title.
 *
 * @property eventIds - the array of ids of the events associated with this title
 */
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

/**
 * Loads the embeddings database from disk into memory.
 *
 * Attempts to read the embeddings from the primary database file. If reading fails
 *  and `tryLoadFromBackup` is `true`, it restores the
 * database from a backup file and retries the load operation once.
 *
 * @param tryLoadFromBackup - Whether to attempt restoring from a backup file if loading fails. 
 * Defaults to `true`.
 * @throws Will throw an error if loading fails and restoring from backup is not attempted or also fails.
 */
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

/**
 * Creates a backup of the current database file by copying it to the backup location.
 * Writes the current state of the `embeddingDB` object to the main database file in JSON format.
 *
 * @returns {Promise<void>} A promise that resolves when the flush operation is complete.
 * @throws Will throw an error if the file copy or write operations fail.
 */
export async function flushEmbeddings() {
  // Copy current file to backup
  await fs.copyFile(DB_PATH, DB_PATH_BACKUP);
  await fs.writeFile(DB_PATH, JSON.stringify(embeddingDB));
}

/**
 * Inserts or updates an embedding in the embedding database.
 *
 * If an embedding with the given key already exists, merges the provided `eventIds`
 * from the metadata with the existing ones, ensuring uniqueness.
 * Otherwise, creates a new entry with the given embeddings and metadata.
 *
 * @param key - The unique identifier for the embedding.
 * @param embeddings - The array of embedding values to store.
 * @param metadata - The metadata associated with the embedding, including `eventIds` 
 * (the array of ids of the events associated with this title).
 */
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

/**
 * Deletes an embedding from the `embeddingDB` using the specified key.
 *
 * @param key - The unique identifier of the embedding to be deleted.
 */
export function deleteEmbedding(key: string) {
  delete embeddingDB[key];
}

/**
 * Retrieves the embedding and its associated metadata for a given key from the embedding database.
 *
 * @param key - The unique identifier used to look up the embedding.
 * @returns An object containing the embedding vector (`embeddings`) and its metadata (`metadata`), 
 *          or `undefined` if the key does not exist in the database.
 */
export function getEmbedding(
  key: string
): { embeddings: number[]; metadata: EmbeddingMetadata } | undefined {
  return embeddingDB[key];
}

/**
 * Calculates the squared Euclidean distance between two embedding vectors.
 *
 * @param embeddings1 - The first embedding vector as an array of numbers.
 * @param embeddings2 - The second embedding vector as an array of numbers.
 * @returns The squared Euclidean distance between the two vectors.
 *
 * @remarks
 * This function assumes that both input arrays have the same length.
 * The result is not the actual Euclidean distance, but its squared value.
 */
export function getDistance(embeddings1: number[], embeddings2: number[]) {
  let distance = 0;
  for (let i = 0; i < embeddings1.length; i++) {
    distance += (embeddings1[i] - embeddings2[i]) ** 2;
  }
  return distance;
}

/**
 * Finds the k nearest neighbors to a given target vector from the embedding database.
 *
 * @param target - The target vector to compare against the embeddings in the database.
 * @param k - The number of nearest neighbors to return. Defaults to 1.
 * @returns An array of tuples, each containing the key and the distance to the target vector,
 *          sorted in ascending order by distance. Only the top k closest neighbors are returned.
 */
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

/**
 * Acquires a lock for exclusive access to a shared resource.
 * 
 * If no other waiters are present, the lock is acquired immediately.
 * Otherwise, the caller is queued and will be resumed when the lock becomes available.
 * 
 * @returns {Promise<void>} Resolves when the lock has been acquired.
 */
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


/**
 * Releases a lock held by the current caller and wakes up the next waiter, if any.
 *
 * This function checks if there are any waiters in the queue. If the first waiter is undefined,
 * it removes it from the queue. If there are no more waiters, it simply returns.
 * Otherwise, it resolves the promise of the next waiter, allowing them to acquire the lock.
 *
 * Assumes that `waiters` is a queue of deferred promises representing pending lock requests.
 */
export function releaseLock() {
  // waiters.length == 0: only I am using it and nobody else is waiting
  if (waiters[0] === undefined) waiters.shift();
  if (waiters.length == 0) return;
  const deferred = waiters.shift()!;
  deferred.resolve();
}
