import { Event } from "@prisma/client";
import dedent from "dedent";
import { ChatCompletionFunctions } from "openai";

import { createChatCompletionWithRetry, removeArtifacts, removeBase64 } from "./utils.js";
import { CHEAP_MODEL, MODEL } from "./utils.js";

export const CURRENT_MODEL_NAME = "TAG-20241002";


// PLAYsentation (Class Presentation), Logar(Concert), Alien Conspiracy

const PROMPT_INTRO = dedent`
  You are a campus event tagger. Your job is to reason whether given tags apply to a specific event.

  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:

  Title: {INSERT TITLE HERE}

`;

const ACCEPTABLE_FORM_TAGS = [
  "Theater",
  "Concert",
  "Talk",
  "Study Break",
  "Movie Screening",
  "Game",
  "Sale",
  "Rally",
  "Dance",
  "Party",
  "Class Presentation"
];

const FORM_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify the form tag for the event above.

  Start with the form of the event. Possible event forms (choose the closest one) (after | is explanation, not part of tag):
  - Theater (like a play or a musical, relating to theater)
  - Concert
  - Talk | (including workshops)
  - Movie Screening
  - Game
  - Sale | (including fundraising)
  - Dance | (dance show or dance party)
  - Rally
  - Party | (including carnivals and festivals)
  - Class Presentation | (usually by students demonstrating their class projects)
  - Study Break | (relaxing event usually with food)

  Go through each tag above and give reasons whether each tag applies. Then finally give the tag you choose and why you choose it.

  Your answer must begin with: "Out of the the tags [${ACCEPTABLE_FORM_TAGS.join(", ")}]..."

  `;

const EVENT_FORM_TAG_FUNCTION: ChatCompletionFunctions = {
  name: "tag_event_form",
  description: "Add form tag to event",
  parameters: {
    type: "object",
    properties: {
      form_tag: {
        type: "string",
        description: "The tag of the form of the event.",
        enum: ACCEPTABLE_FORM_TAGS
      }
    },
    require: ["form_tag"]
  }
};

const ACCEPTABLE_CONTENT_TAGS = [
  "EECS",
  "AI",
  "Math",
  "Biology",
  "Finance",
  "Career",
  "East Asian",
  "Religion",
  "Queer"
];

const CONTENT_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify the (up to two) content tags for the event above.

  The event's content focuses on (choose at most two, don't have to choose any if not relevant):
  - EECS | (Electrical Engineering and Computer Science, including topics in software, hardware, and related areas)
  - AI
  - Math
  - Biology
  - Finance | (including Quant)
  - Career | (related to jobs and industries)
  - East Asian
  - Religion
  - Queer | (only if LGBTQ+ is specifically mentioned. Mentioning of a queer color doesn't count.)

  First analyze each tag, then output ONLY a JSON object in this exact format:

  For two tags:
  {
    "content_tag_1": "TAG_NAME",
    "content_tag_2": "TAG_NAME",
    "justification": "Your reasoning for why these tags apply"
  }

  For one tag:
  {
    "content_tag_1": "TAG_NAME",
    "justification": "Your reasoning for why this tag applies"
  }

  For no tags:
  {}

  Example output for an AI workshop event:
  {
    "content_tag_1": "AI",
    "content_tag_2": "EECS",
    "justification": "This event is primarily about artificial intelligence algorithms and their implementation in computer systems"
  }

  DO NOT include any other text before or after the JSON object.
  `;

const EVENT_CONTENT_TAG_GRAMMAR = dedent`
  content-tag-1 ::= "\"EECS\"" | "\"AI\"" | "\"Math\"" | "\"Biology\"" | "\"Finance\"" | "\"Career\"" | "\"East Asian\"" | "\"Religion\"" | "\"Queer\""
  content-tag-1-kv ::= "\"content_tag_1\"" space ":" space content-tag-1
  content-tag-1-rest ::= ( "," space content-tag-2-kv )? ("," space justification-kv)?
  content-tag-2 ::= "\"EECS\"" | "\"AI\"" | "\"Math\"" | "\"Biology\"" | "\"Finance\"" | "\"Career\"" | "\"East Asian\"" | "\"Religion\"" | "\"Queer\""
  content-tag-2-kv ::= "\"content_tag_2\"" space ":" space content-tag-2
  justification ::= "\\"" [^"]* "\\""
  justification-kv ::= "\"justification\"" space ":" space justification
  root ::= "{" space (content-tag-1-kv content-tag-1-rest | content-tag-2-kv ("," space justification-kv)?) "}" space
  space ::= " "?
`

const AMENITIES_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify whether the specified event contains food or boba.

  If you think the email contains food, snacks, or boba, output the part of the email that indicates whether the event contains food or boba.

  If you think the email does not contain food, snacks, or boba, say why the event is unlikely to provide any edible items.

  At the end of your reasoning, suggest a tag from ["Food", "Boba", "None"]. (Pick boba if the event provides both)
`;

const ACCEPTABLE_AMENITIES_TAGS = ["Free Food", "Boba", "Food", "None"];

const EVENT_AMENITIES_TAG_FUNCTION: ChatCompletionFunctions = {
  name: "tag_event_amenities",
  description: "Add amenities tag to event",
  parameters: {
    type: "object",
    properties: {
      amenities_tag: {
        type: "string",
        description: "The tag of the amenities of the event (not necessary).",
        enum: ACCEPTABLE_AMENITIES_TAGS
      },
      type_of_food: {
        type: "string",
        description: "What food the event provides, if tagged with 'Free Food'."
      }
    },
    require: ["amenities_tag", "type_of_food"]
  }
};

function extractAndSanitizeJsonContent(content: string): string {
  const jsonMatch = content.match(/{.*}/s);
  if (!jsonMatch) {
    return '';
  }

  return jsonMatch[0].replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
};

export async function doCompletion(prompt: string, grammar: string): Promise<any> {
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

     const data = await response.json();
     const content = data["choices"][0]["message"]["content"];
     return JSON.parse(extractAndSanitizeJsonContent(content));

  } catch (error) {
     console.error(`Error with completion:`, error);
     throw error;
  }
}

export async function addTagsToEvent(event: Event): Promise<string[]> {
  const text = removeArtifacts(event.text);

  async function twoStagePrompt(
    prompt: string,
    fn: ChatCompletionFunctions,
    allowed: string[]
  ): Promise<string[]> {
    const results: string[] = [];
    const systemPrompt = prompt.replace("{INSERT TITLE HERE}", event.title);
    const responseFirstStage = await createChatCompletionWithRetry({
      model: CHEAP_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ],
      temperature: 0
    });
    const responseSecondStage = await createChatCompletionWithRetry({
      model: CHEAP_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
        { role: "assistant", content: responseFirstStage },
        {
          role: "user",
          content:
            "Remember, you can only pick from the tags given above. Now call the function with the tag of your conclusion:"
        }
      ],
      functions: [fn],
      function_call: { name: fn.name },
      temperature: 0
    });
    if (process.env.DEBUG_MODE) {
      console.log("----------Extracted Tags----------");
      console.log(responseSecondStage);
      console.log("----------Justification---------");
      console.log(responseFirstStage);
      console.log("----------End Response----------");
    }
    for (let property in responseSecondStage)
      if (allowed.includes(responseSecondStage[property]))
        results.push(responseSecondStage[property]);
    return results;
  }

  async function extractTags(prompt: string, grammar: string, allowed: string[]): Promise<string[]> {
    const systemPrompt = prompt.replace("{INSERT TITLE HERE}", event.title);
    try {
      const response = await doCompletion(
        `${systemPrompt}\n\`\`\`\n${text}\n\`\`\`\n\n---------------- Response --------------\n`,
        grammar
      )

      const tags = [response].flatMap(tags => Object.values(tags) as string[])
                               .filter((tag) => allowed.includes(tag));

      if (process.env.DEBUG_MODE) {
        console.log("----------Extracted Tags----------");
        console.log(tags);
        console.log("----------Justification---------");
        console.log(response["justification"]);
        console.log("----------End Response----------");
      }

      return tags;
    } catch (error) {
      console.log(`Error with extracting tags for ${event.title}:`, error);
      return [];
    }
  }

  // TODO: Update all types of tags to use SIPB LLMs endpoint in doCompletion by invoking extractTags
  const [formTags, contentTags, amenitiesTags] = await Promise.all([
    twoStagePrompt(FORM_TAG_PROMPT, EVENT_FORM_TAG_FUNCTION, ACCEPTABLE_FORM_TAGS),
    extractTags(CONTENT_TAG_PROMPT, EVENT_CONTENT_TAG_GRAMMAR, ACCEPTABLE_CONTENT_TAGS),
    twoStagePrompt(AMENITIES_TAG_PROMPT, EVENT_AMENITIES_TAG_FUNCTION, ACCEPTABLE_AMENITIES_TAGS)
  ]);

  let results = formTags.concat(contentTags).concat(amenitiesTags.filter((tag) => tag !== "None"));
  results = [...new Set(results)];
  return results;
}
