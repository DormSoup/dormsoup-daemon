import * as fs from "fs/promises";

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

export async function loadEmbeddings() {
  const data = await fs.readFile(DB_PATH, "utf-8");
  embeddingDB = JSON.parse(data);
}

export async function flushEmbeddings() {
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
