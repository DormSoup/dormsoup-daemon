import assert from "assert";
import dotenv from "dotenv";
import { generateEmbedding } from "./SIPBLLMsUtils";

dotenv.config();

export interface Event {
  title: string;
  dateTime: Date;
  location: string;
  organizer: string;
}

/**
 * Estimates the number of tokens in a given text string.
 *
 * @param text - The input string to estimate token count for.
 * @returns The estimated number of tokens in the input text.
 */
export function estimateTokens(text: string): number {
  const crudeEstimate = text.length / 4;
  const educatedEstimate = text.split(/\b/g).filter((word) => word.trim().length > 0).length / 0.75;
  return Math.ceil(Math.max(crudeEstimate, educatedEstimate));
}

/**
 * Generates an embedding vector for a given title string by prefixing it with "clustering:". 
 * (see https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)
 * @param text - The title text to embed.
 * @returns A promise that resolves to an array of numbers representing the embedding vector.
 */
export async function createTitleEmbedding(text: string): Promise<number[]> {
  const textToEmbed = `clustering: ${text}`
  return generateEmbedding('nomic-embed-text:latest', textToEmbed);
}


/**
 * Removes all base64-encoded data segments from the input string.
 *
 * @param input - The string potentially containing base64-encoded data segments.
 * @returns The input string with all base64-encoded data segments removed.
 */
export function removeBase64(input: string) {
  // Searches for occurrence of `;base64,` marker in the input string.
  const startKeyword = ";base64,";
  const start = input.indexOf(";base64,");
  if (start === -1) return input;
  let end = start + startKeyword.length;
  // Remove the subsequent base64-encoded data until a non-base64 character is found.
  while (end < input.length) {
    const charCode = input.charCodeAt(end);
    if (65 <= charCode && charCode <= 90) end++;
    else if (97 <= charCode && charCode <= 122) end++;
    else if (48 <= charCode && charCode <= 57) end++;
    else if (charCode === 43 || charCode === 47 || charCode === 61) end++;
    else break;
  }
  // Repeated recursively until no more base64 segments are present.
  return removeBase64(input.slice(0, start) + input.slice(end));
}

/**
 * Removes image tags from the input string that match the pattern `[cid:...]` or `[data:...]`.
 *
 * @param input - The string from which image tags should be removed.
 * @returns The input string with all `[cid:...]` and `[data:...]` tags removed.
 */
export function removeImageTags(input: string) {
  // searches for and removes any substrings enclosed in square brackets that start with either 
  // `cid:` or `data:`, followed by any characters except a closing bracket.
  return input.replace(/\[(cid|data):[^\]]+\]/g, "");
}

/**
 * Removes consecutive line breaks from the input string, reducing any sequence of three or more line breaks (optionally with whitespace)
 * to just two line breaks.
 *
 * @param input - The string to process and normalize line breaks in.
 * @returns The input string with no more than two consecutive line breaks.
 */
export function removeConsecutiveLinebreaks(input: string) {
  return input.replace(/(\n\s*){3,}/g, "\n\n");
}

/**
 * Removes all URLs from the input string.
 *
 * @param input - The string from which URLs should be removed.
 * @returns The input string with all URLs removed.
 */
export function removeURL(input: string) {
  // Searches for and removes both plain URLs (e.g., "https://example.com")
  // and URLs enclosed in square brackets (e.g., "[https://example.com]") from the given string.
  return input.replace(/(https?:\/\/[^\s]+)|(\[https?:\/\/[^\s]+\])/g, "");
}

/**
 * Removes various unwanted artifacts from the input string, including base64 data,
 * URLs, image tags, and consecutive line breaks.
 *
 * @param input - The string to clean up.
 * @returns The cleaned string with artifacts removed.
 */
export function removeArtifacts(input: string) {
  return removeConsecutiveLinebreaks(removeImageTags(removeURL(removeBase64(input))));
}

/**
 * Formats a given Date object into a string representing the date and time
 * in the Eastern Time (ET) zone (America/New_York), using the "en-US" locale.
 * The output includes year, month, day, hour, minute, and second, all in
 * two-digit format where applicable, and uses a 24-hour clock.
 *
 * @param date - The Date object to format.
 * @returns A string representing the formatted date and time in ET. (ex. "06/01/2024, 11:30:00")
 */
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
