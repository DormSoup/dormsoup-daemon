import { assert } from "console";
import { JSONSchema7 } from "json-schema";

const SIPB_LLMS_LLAMACPP_ENDPOINT = process.env.SIPB_LLMS_API_ENDPOINT;
const SIPB_LLMS_LLAMACPP_API_TOKEN = process.env.SIPB_LLMS_API_TOKEN;
const SIPB_LLMS_OLLAMA_ENDPOINT = process.env.SIPB_ENDPOINT_OLLAMA;
const SIPB_LLMS_OWUI_API_TOKEN = process.env.SIPB_LLMS_OWUI_API_TOKEN
assert(SIPB_LLMS_LLAMACPP_ENDPOINT !== undefined, "SIPB_LLMS_LLAMACPP_ENDPOINT environment variable must be set");
assert(SIPB_LLMS_OLLAMA_ENDPOINT !== undefined, "SIPB_LLMS_OLLAMA_ENDPOINT environment variable must be set");
assert(SIPB_LLMS_OWUI_API_TOKEN !== undefined, "SIPB_LLMS_OWUI_API_TOKEN environment variable must be set");
assert(SIPB_LLMS_LLAMACPP_API_TOKEN !== undefined, "SIPB_LLMS_LLAMACPP_API_TOKEN environment variable must be set");
interface SIPBLLMUsage {
  completion_tokens: number,
  prompt_tokens: number,
  total_tokens: number
}
interface SIPBLLMMessage {content: string; role: string};
interface SIPBLLMChoice {
  finish_reason: string;
  index: number;
  message: SIPBLLMMessage
};
interface SIPBLLMLlamaResponse {
  choices: Array<SIPBLLMChoice>;
  created: number;
  model: string;
  object: string;
  usage: SIPBLLMUsage;
  id: string;
};

interface SIPBLLMOllamaResponse {
    message: SIPBLLMMessage;
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

function extractAndSanitizeJsonContent(content: string): string {
  const jsonMatch = content.match(/{.*}/s);
  if (!jsonMatch) {
    return '';
  }
  return jsonMatch[0].replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
};

export async function doSIPBLLMsCompletionGrammar(prompt: string, grammar: string): Promise<Record<string, any>> {
  try {
     const response = await fetch(`${SIPB_LLMS_LLAMACPP_ENDPOINT}`, {
        method: "POST",
        headers: {
           "Authorization": `Bearer ${SIPB_LLMS_LLAMACPP_API_TOKEN}`,
           "Content-Type": `application/json`,
        },
        body: JSON.stringify({
           "messages": [
              {"role": "user", "content": prompt},
           ],
           "stream": false,
           "tokenize": true,
           "stop": ["</s>", "### User Message", "### Assistant", "### Prompt"],
           "cache_prompt": false,
           "frequency_penalty": 0,
           "grammar": grammar,
           "image_data": [],
           //"model": "mixtral",
           "min_p": 0.05,
           "mirostat": 0,
           "mirostat_eta": 0.1,
           "mirostat_tau": 5,
           "n_predict": 1000,
           "n_probs": 0,
           "presence_penalty": 0,
           "repeat_last_n": 256,
           "repeat_penalty": 1.18,
           "seed": -1,
           "slot_id": -1,
           "temperature": 0.7,
           "tfs_z": 1,
           "top_k": 40,
           "top_p": 0.95,
           "typical_p": 1,
        }),
     });

     if (!response.ok)
        throw new Error(`HTTP error: ${response.status}. Response: ${await response.text()}`);
  
     const data: SIPBLLMLlamaResponse = await response.json() as SIPBLLMLlamaResponse;
     const content = data["choices"][0]["message"]["content"];
     return JSON.parse(extractAndSanitizeJsonContent(content));

  } catch (error) {
     console.error(`Error with completion:`, error);
     throw error;
  }
}

export async function doSIPBLLMsCompletionJSONSchema(systemPrompt: string, userPrompt: string, jsonSchema: JSONSchema7, model: "deepseek-r1:32b" | "mixtral"): Promise<Record<string, any>> {
    const endpoint = model == "deepseek-r1:32b" ? SIPB_LLMS_OLLAMA_ENDPOINT: SIPB_LLMS_LLAMACPP_ENDPOINT;
    const token = model == "deepseek-r1:32b" ? SIPB_LLMS_OWUI_API_TOKEN: SIPB_LLMS_LLAMACPP_API_TOKEN
    try {
       const formatter = model=="deepseek-r1:32b" ? {"format": {"type": "object", ...jsonSchema }}:{"response_format": {"type": "json_object", "schema":jsonSchema }}
       const body = {
        "model": model,
         "messages": [
            {"role": "system", "content": systemPrompt},
            {"role": "user", "content": userPrompt},
         ],
         "stream": false,
        //  "tokenize": true,
        //  "stop": ["</s>", "### User Message", "### Assistant", "### Prompt"],
        //  "cache_prompt": false,
        //  "frequency_penalty": 0,
        //  "image_data": [],
        //  "min_p": 0.05,
        //  "mirostat": 0,
        //  "mirostat_eta": 0.1,
        //  "mirostat_tau": 5,
        //  "n_predict": 1000,
        //  "n_probs": 0,
        //  "presence_penalty": 0,
        //  "repeat_last_n": 256,
        //  "repeat_penalty": 1.18,
        //  "seed": -1,
        //  "slot_id": -1,
        //  "temperature": 0.7,
        //  "tfs_z": 1,
        //  "top_k": 40,
        //  "top_p": 0.95,
        //  "typical_p": 1,
         ...formatter
      }

       const response = await fetch(`${endpoint}`, {
          method: "POST",
          headers: {
             "Authorization": `Bearer ${token}`,
             "Content-Type": `application/json`,
          },
          body: JSON.stringify(body),
       });
  
       if (!response.ok)
          throw new Error(`HTTP error: ${response.status}. Response: ${await response.text()}`);
       let content;
       if (model == "deepseek-r1:32b"){ 
        const data: SIPBLLMOllamaResponse = await response.json() as SIPBLLMOllamaResponse;
        content = data["message"]["content"];
       }
       else{
        const data: SIPBLLMLlamaResponse = await response.json() as SIPBLLMLlamaResponse;
        content = data["choices"][0]["message"]["content"];
       }

       return JSON.parse(extractAndSanitizeJsonContent(content));
  
    } catch (error) {
       console.error(`Error with completion:`, error);
       throw error;
    }
  }
  