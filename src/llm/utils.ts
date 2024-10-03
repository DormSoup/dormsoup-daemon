import assert from "assert";
import dotenv from "dotenv";
import HttpStatus from "http-status-codes";
import { RateLimiter } from "limiter-es6-compat";
import { Configuration, CreateChatCompletionRequest, OpenAIApi } from "openai";

dotenv.config();

export const CHEAP_MODEL = "gpt-4o-mini-2024-07-18";
export const MODEL = "gpt-4o-2024-08-06";

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

type LLMRateLimiter = {
  rpmLimiter: RateLimiter;
  tpmLimiter: RateLimiter;
};

const GPT_3_LIMITER: LLMRateLimiter = {
  rpmLimiter: new RateLimiter({ tokensPerInterval: 3500, interval: "minute" }),
  tpmLimiter: new RateLimiter({ tokensPerInterval: 60000, interval: "minute" })
};

const GPT_4_LIMITER: LLMRateLimiter = {
  rpmLimiter: new RateLimiter({ tokensPerInterval: 200, interval: "minute" }),
  tpmLimiter: new RateLimiter({ tokensPerInterval: 30000, interval: "minute" })
};

const MODEL_LIMITERS: { [modelName: string]: LLMRateLimiter } = {
  "gpt-3.5-turbo-0613": GPT_3_LIMITER,
  "gpt-3.5-turbo-16k-0613": GPT_3_LIMITER,
  "gpt-4-0613": GPT_4_LIMITER,
  CHEAP_MODEL: GPT_3_LIMITER,
  MODEL: GPT_4_LIMITER
};

export function estimateTokens(text: string): number {
  const crudeEstimate = text.length / 4;
  const educatedEstimate = text.split(/\b/g).filter((word) => word.trim().length > 0).length / 0.75;
  return Math.ceil(Math.max(crudeEstimate, educatedEstimate));
}

function truncate(text: string, threshold: number = 100): string {
  return text.length < threshold ? text : text.substring(0, Math.max(0, threshold - 4)) + " ...";
}

export async function createChatCompletionWithRetry(
  request: CreateChatCompletionRequest,
  backOffTimeMs: number = 1000
): Promise<any> {
  let response;
  const limiter = MODEL_LIMITERS[request.model];
  const text = request.messages.map((msg) => msg.content).join("\n");
  if (limiter !== undefined) {
    const tokens = estimateTokens(text);
    await limiter.rpmLimiter.removeTokens(1);
    await limiter.tpmLimiter.removeTokens(tokens);
  }

  while (true) {
    response = await openai.createChatCompletion(request, {
      validateStatus: (status) => true
    });
    if (response.status === HttpStatus.OK) break;
    if (
      response.status === HttpStatus.TOO_MANY_REQUESTS ||
      response.status === HttpStatus.SERVICE_UNAVAILABLE ||
      response.status === HttpStatus.BAD_GATEWAY
    ) {
      await new Promise((resolve) => setTimeout(resolve, backOffTimeMs));
      backOffTimeMs = Math.min(20000, backOffTimeMs * 1.5);
      console.warn(
        `Request error, backing off in ${backOffTimeMs} ms. Request test ${truncate(text)}`,
        response
      );
    } else if (response.status === HttpStatus.BAD_REQUEST) {
      if (process.env.DEBUG_MODE) console.warn("Bad request: ", response);
    } else {
      console.log("Unexpected response: ", response);
      throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    }
  }
  const completion = response.data.choices[0];
  assert(
    completion.finish_reason === "stop" || completion.finish_reason === "function_call",
    "OpenAI API call failed"
  );
  if (completion.message?.content) return completion.message?.content;
  let completionArguments = completion.message?.function_call?.arguments;
  assert(completionArguments !== undefined);
  try {
    return JSON.parse(completionArguments);
  } catch (error) {
    console.log("JSON parse error from parsing ", completionArguments);
    throw error;
  }
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
