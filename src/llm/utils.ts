import assert from "assert";
import dotenv from "dotenv";
import { Configuration, OpenAIApi } from "openai";

dotenv.config();

export interface Event {
  title: string;
  dateTime: Date;
  location: string;
  organizer: string;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
assert(OPENAI_API_KEY !== undefined, "OPENAI_API_KEY environment variable must be set");

const openai = new OpenAIApi(
  new Configuration({
    apiKey: OPENAI_API_KEY
  })
);

export function estimateTokens(text: string): number {
  const crudeEstimate = text.length / 4;
  const educatedEstimate = text.split(/\b/g).filter((word) => word.trim().length > 0).length / 0.75;
  return Math.ceil(Math.max(crudeEstimate, educatedEstimate));
}

function truncate(text: string, threshold: number = 100): string {
  return text.length < threshold ? text : text.substring(0, Math.max(0, threshold - 4)) + " ...";
}

export async function createEmbedding(text: string): Promise<number[]> {
  const response = await openai.createEmbedding({
    model: "text-embedding-ada-002",
    input: text
  });
  return response.data.data[0].embedding;
}

export function removeBase64(input: string) {
  const startKeyword = ";base64,";
  const start = input.indexOf(";base64,");
  if (start === -1) return input;
  let end = start + startKeyword.length;
  while (end < input.length) {
    const charCode = input.charCodeAt(end);
    if (65 <= charCode && charCode <= 90) end++;
    else if (97 <= charCode && charCode <= 122) end++;
    else if (48 <= charCode && charCode <= 57) end++;
    else if (charCode === 43 || charCode === 47 || charCode === 61) end++;
    else break;
  }
  return removeBase64(input.slice(0, start) + input.slice(end));
}

export function removeImageTags(input: string) {
  return input.replace(/\[(cid|data):[^\]]+\]/g, "");
}

export function removeConsecutiveLinebreaks(input: string) {
  return input.replace(/(\n\s*){3,}/g, "\n\n");
}

export function removeURL(input: string) {
  return input.replace(/(https?:\/\/[^\s]+)|(\[https?:\/\/[^\s]+\])/g, "");
}

export function removeArtifacts(input: string) {
  return removeConsecutiveLinebreaks(removeImageTags(removeURL(removeBase64(input))));
}

export function formatDateInET(date: Date) {
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/New_York",
    hour12: false
  });
}
