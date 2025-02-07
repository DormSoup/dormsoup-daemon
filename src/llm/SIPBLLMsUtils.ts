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
interface SIPBLLMResponse {
  choices: Array<SIPBLLMChoice>;
  created: number;
  model: string;
  object: string;
  usage: SIPBLLMUsage;
  id: string;
};

function extractAndSanitizeJsonContent(content: string): string {
  const jsonMatch = content.match(/{.*}/s);
  if (!jsonMatch) {
    return '';
  }
  return jsonMatch[0].replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
};

export async function doSIPBLLMsCompletion(prompt: string, grammar: string): Promise<Record<string, any>> {
  try {
     const response = await fetch(`${process.env.SIPB_LLMS_API_ENDPOINT}`, {
        method: "POST",
        headers: {
           "Authorization": `Bearer ${process.env.SIPB_LLMS_API_TOKEN}`,
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
  
     const data: SIPBLLMResponse = await response.json() as SIPBLLMResponse;
     const content = data["choices"][0]["message"]["content"];
     return JSON.parse(extractAndSanitizeJsonContent(content));

  } catch (error) {
     console.error(`Error with completion:`, error);
     throw error;
  }
}
