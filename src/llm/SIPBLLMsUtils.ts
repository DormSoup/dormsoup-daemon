import { assert } from "console";
import { JSONSchema7 } from "json-schema";

const SIPB_LLMS_OLLAMA_ENDPOINT = process.env.SIPB_ENDPOINT_OLLAMA;
const SIPB_LLMS_OWUI_API_TOKEN = process.env.SIPB_LLMS_OWUI_API_TOKEN
assert(SIPB_LLMS_OLLAMA_ENDPOINT !== undefined, "SIPB_LLMS_OLLAMA_ENDPOINT environment variable must be set");
assert(SIPB_LLMS_OWUI_API_TOKEN !== undefined, "SIPB_LLMS_OWUI_API_TOKEN environment variable must be set");

export type SIPBLLMsChatMessage = {
   role: "system" | "user" | "assistant";
   content: string;
};

export type SIPBLLMsChatModel = "deepseek-r1:32b" | "mixtral" | 'aya:35b' | 'exaone3.5:32b';

export type SIPBLLMsEmbeddingModel = 'nomic-embed-text:latest';

type SIPBLLMsEmbeddingInput = Array<any> | Array<number> | Array<string> | string;

interface SIPBLLMOllamaChatResponse {
    message: SIPBLLMsChatMessage;
    created_at: string;
    model: string;
    done_reason: string;
    done: boolean;
    total_duration: number;
    load_duration: number;
    prompt_eval_count: number;
    prompt_eval_duration: number;
    eval_count: number;
    eval_duration: number;
};

type SIPBLLMOllamaEmbedAPIResponse = {
  "model": string,
  "embeddings": Array<Array<number>>,
  "total_duration": number,
  "load_duration": number,
  "prompt_eval_count": number
}

interface OllamaFormat extends JSONSchema7 {
   type: "object";
}

interface SIPBLLMsChatRequestBody {
   model: SIPBLLMsChatModel;
   messages: SIPBLLMsChatMessage[];
   stream: boolean;
   // Ollama endpoint
   format?: OllamaFormat;
}

/**
 * Extracts and sanitizes JSON content from a given string.
 *
 * This function searches for the first JSON object within the input string
 * and returns it with necessary escape characters sanitized. If no JSON
 * object is found, it returns an empty string.
 *
 * @param content - The string containing the JSON content to be extracted and sanitized.
 * @returns The sanitized JSON content as a string, or an empty string if no JSON object is found.
 */
function extractAndSanitizeJsonContent(content: string): string {
  const jsonMatch = content.match(/{.*}/s);
  if (!jsonMatch) {
    return '';
  }
  return jsonMatch[0].replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
};


/**
 * Sends a request with the given JSON schema to the specified SIPBLLMs Ollama model
 * and returns the response.
 *
 * @param messages - An array of SIPBLLMMessage objects to be sent to the LLM model.
 * @param jsonSchema - A JSON schema object defining the desired structure of the response.
 * @param model - The LLM model to use.
 * @returns A promise that resolves to the response by the model, a record of the desired structure.
 * @throws Will throw an error if the HTTP request fails or the response cannot be parsed.
 */
async function SIPLLMsStructed(messages: Array<SIPBLLMsChatMessage>, model: SIPBLLMsChatModel, jsonSchema: JSONSchema7, ): Promise<Record<string, any>> {
   const body = {
      model: model,
      messages: messages,
      stream: false,
      format: {type: "object", ...jsonSchema }
   } as SIPBLLMsChatRequestBody;
   return await SIPBLLMsChatAPICall(body) as Promise<Record<string, any>>;
}

/**
 * Makes an SIPBLLMs API call to the SIPBLLMs Ollama endpoint with the provided request body.
 * 
 * @param body - The request body to send in the API call.
 * @returns A promise that resolves to the response by the model.
 * @throws Will throw an error if the response is not ok or if there is an issue with the call.
 */
async function SIPBLLMsChatAPICall(body: SIPBLLMsChatRequestBody): Promise<Record<string, any> | string>{
   try{
      const response = await fetch(`${SIPB_LLMS_OLLAMA_ENDPOINT!}`+'/api/chat', {
         method: "POST",
         headers: {
            "Authorization": `Bearer ${SIPB_LLMS_OWUI_API_TOKEN}`,
            "Content-Type": `application/json`,
         },
         body: JSON.stringify(body),
      });

      if (!response.ok)
         throw new Error(`HTTP error: ${response.status}. Response: ${await response.text()}`);
      const data: SIPBLLMOllamaChatResponse = await response.json() as SIPBLLMOllamaChatResponse;
      const content = data["message"]["content"];
      if (body.format){
         return JSON.parse(extractAndSanitizeJsonContent(content));
      }
      else{
         return content
      }

   } catch (error) {
      console.error(`Error with completion:`, error);
      throw error;
   }
}

/**
 * Sends a request to the specified SIPB LLMs Ollama model with the provided messages
 * and returns the response.
 *
 * @param messages - An array of SIPBLLMMessage objects to be sent to the LLM model.
 * @param model - The model to be used for the request.
 * @returns A promise that resolves to the response by the model, a string.
 * @throws Will throw an error if the HTTP request fails or if the response is not in the expected format.
 */
async function SIPBLLMsUnstructed(messages: Array<SIPBLLMsChatMessage>, model: SIPBLLMsChatModel): Promise<string> {
   const body = {
      "model": model,
      "messages": messages,
      "stream": false,
   };
   return await SIPBLLMsChatAPICall(body) as Promise<string>;
}


/**
 * Sends a request to SIPBLLMs with the given JSON schema to the specified SIPB LLMs Ollama model
 * and returns the response.
 *
 * @param messages - An array of SIPBLLMMessage objects to be processed.
 * @param model - The model to use for processing the messages.
 * @param jsonSchema - An optional JSON schema to validate the output against.
 * @returns A promise that resolves to a record of key-value pairs or a string, depending on whether a JSON schema is provided.
 */
export async function SIPBLLMs(messages: Array<SIPBLLMsChatMessage>, model: SIPBLLMsChatModel, jsonSchema?: JSONSchema7): Promise<Record<string, any> | string> {
    if (jsonSchema){
      return SIPLLMsStructed(messages, model, jsonSchema);
    }
    else{
      return SIPBLLMsUnstructed(messages, model);
    }
  }

/**
 * Generates an embedding for the provided input using the specified embedding model hosted by SIPBLLMs.
 *
 * @param model - The embedding model to use for generating the embedding.
 * @param input - The input data to generate the embedding for. Can be an array of any type, an array of numbers, an array of strings, or a single string.
 * @throws if an issue occurs while generating the embedding
 * @returns A promise that resolves to the generated embedding.
 */
export async function generateEmbedding(model: SIPBLLMsEmbeddingModel, input: SIPBLLMsEmbeddingInput): Promise<number[]>{
      try{
         const response = await fetch(`${SIPB_LLMS_OLLAMA_ENDPOINT!}`+'/api/embed', {
            method: "POST",
            headers: {
               "Authorization": `Bearer ${SIPB_LLMS_OWUI_API_TOKEN}`,
               "Content-Type": `application/json`,
            },
            body: JSON.stringify({model, input}),
         });
         const data = await response.json() as SIPBLLMOllamaEmbedAPIResponse;

         if (!response.ok){
            throw new Error(`HTTP error: ${response.status}. Response: ${await response.text()}`);
         }
         return data.embeddings[0];
      }
      catch (error) {
         console.error(`Error with embedding generation:`, error);
         throw error;
      }
}