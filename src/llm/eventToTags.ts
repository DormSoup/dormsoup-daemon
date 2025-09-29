import { Event } from "@prisma/client";
import dedent from "dedent";
import { removeArtifacts } from "./utils.js";
import { SIPBLLMs, SIPBLLMsChatModel} from "./SIPBLLMsUtils.js";
import { JSONSchema7 } from "json-schema";
import { JSONEvent } from "../scripts/utils.js";

export const CURRENT_SIPB_LLMS_TAGGING_MODEL: SIPBLLMsChatModel = 'deepseek-r1:32b';
export const CURRENT_TAGGING_MODEL_DISPLAY_NAME = `SIPBLLMs (${CURRENT_SIPB_LLMS_TAGGING_MODEL})`;

type FormTag =
  | "Theater"
  | "Concert"
  | "Talk"
  | "Study Break"
  | "Movie Screening"
  | "Game"
  | "Sale"
  | "Rally"
  | "Dance"
  | "Party"
  | "Class Presentation"
  | "Community Service";

type ContentTag =
  | "EECS"
  | "AI"
  | "Math"
  | "Biology"
  | "Finance"
  | "Career"
  | "East Asian"
  | "Religion"
  | "Queer";

type AmenitiesTag =
  | "Free Food"
  | "Boba"
  | "Food"
  | "None";

interface ContentTagResponse {
    content_tag_1?: ContentTag;
    content_tag_2?: ContentTag;
};

interface FormTagResponse {
  form_tag: FormTag;
};

interface AmenitiesTagResponse {
  amenities_tag: AmenitiesTag
};

type TagResponse = AmenitiesTagResponse | FormTagResponse | ContentTagResponse;

const PROMPT_INTRO = dedent`
  You are a campus event tagger. Your job is to reason whether given tags apply to a specific event.

  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:

  Title: {INSERT TITLE HERE}

`;

//---------------------- FORM TAG EXTRACTION  ----------------------//
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
  "Class Presentation",
  "Community Service"
];

const EVENT_FORM_TAG_OUTPUT_SCHEMA: JSONSchema7 = {
  properties: {
    form_tag: {
      type: "string",
      description: "The tag of the form of the event.",
      enum: ACCEPTABLE_FORM_TAGS
    }
  },
  required: ["form_tag"]
};

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
  - Community Service

  Go through each tag above and give reasons whether each tag applies. Then finally give the tag you choose and why you choose it.

  Your answer must begin with: "Out of the the tags [${ACCEPTABLE_FORM_TAGS.join(", ")}]..."

  `;

//---------------------- CONTENT TAG EXTRACTION  ----------------------//
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

const EVENT_CONTENT_TAG_OUTPUT_SCHEMA: JSONSchema7 = {
  properties: {
    content_tag_1: {
      type: "string",
      description: "The first tag of the content of the event. (not necessary)",
      enum: ACCEPTABLE_CONTENT_TAGS
    },
    content_tag_2: {
      type: "string",
      description: "The second tag of the content of the event (not necessary).",
      enum: ACCEPTABLE_CONTENT_TAGS
    }
  },
  required: []
}

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
  }

  For one tag:
  {
    "content_tag_1": "TAG_NAME",
  }

  For no tags:
  {}

  Example output for an AI workshop event:
  {
    "content_tag_1": "AI",
    "content_tag_2": "EECS",
  }

  DO NOT include any other text before or after the JSON object.
  `;

//---------------------- AMENITY TAG EXTRACTION  ----------------------//
const ACCEPTABLE_AMENITIES_TAGS = ["Free Food", "Boba", "Food", "None"];

const EVENT_AMENITIES_TAG_OUTPUT_SCHEMA: JSONSchema7 = {
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
  required: ["amenities_tag", "type_of_food"]
};

const AMENITIES_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify whether the specified event contains food or boba.

  If you think the email contains food, snacks, or boba, output the part of the email that indicates whether the event contains food or boba.

  If you think the email does not contain food, snacks, or boba, say why the event is unlikely to provide any edible items.

  At the end of your reasoning, suggest a tag from [${ACCEPTABLE_AMENITIES_TAGS.join(", ")}]. (Pick boba if the event provides both)
`;


/**
 * Executes a two-stage prompt process to extract tags from an event description.
 * 
 * The two-stage prompt system works as follows:
 * - The first stage generates an initial unstructed response based on the event title and text.
 * - The second stage asks for a structed response and ensures the returned tags are within the allowed set.
 *
 * @param event - The event object containing details about the event.
 * @param text - The text input to be processed by the prompt.
 * @param prompt - The system prompt template with a placeholder for the event title.
 * @param schema - The JSON schema to structure the response of the second stage.
 * @param allowed - An array of allowed tags that can be included in the final result.
 * @returns A promise that resolves to an array of extracted tags that are allowed.
 */
async function twoStagePrompt(
  title: string,
  text: string,
  prompt: string,
  schema: JSONSchema7,
  allowed: string[]
): Promise<string[]> {
  const results: string[] = [];
  const systemPrompt = prompt.replace("{INSERT TITLE HERE}", title);
  const responseFirstStage: string = await SIPBLLMs(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text }
    ],
    CURRENT_SIPB_LLMS_TAGGING_MODEL,
  ) as string;
  const responseSecondStage: TagResponse  = await SIPBLLMs(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
      { role: "assistant", content: responseFirstStage },
      {
        role: "user",
        content:
          "Remember, you can only pick from the tags given above. Now respond with the tag(s) of your conclusion:"
      }
    ],
    CURRENT_SIPB_LLMS_TAGGING_MODEL,
    schema
  ) as TagResponse;
  if (process.env.DEBUG_MODE === 'true') {
    console.log("----------Extracted Tags----------");
    console.log(responseSecondStage);
    console.log("----------Justification---------");
    console.log(responseFirstStage);
    console.log("----------End Response----------");
  }
  for (const property of Object.keys(responseSecondStage)) {
    const tag = responseSecondStage[property as keyof TagResponse];
    if (allowed.includes(tag)) {
      results.push(tag);
    }
  }
  return results;
}

export type MinimalEvent = Pick<Event, "title" | "text">;

/**
 * Generates tags from an event.
 *
 * @param {Event} event - The event object containing the text and title to be processed.
 * @returns {Promise<string[]>} A promise that resolves to an array of tags extracted from the event.
*/
export async function generateEventTags(event: MinimalEvent): Promise<string[]> {
  const text = removeArtifacts(event.text);
  const [formTags, contentTags, amenitiesTags] = await Promise.all([
    twoStagePrompt(event.title, text, FORM_TAG_PROMPT, EVENT_FORM_TAG_OUTPUT_SCHEMA, ACCEPTABLE_FORM_TAGS),
    twoStagePrompt(event.title, text, CONTENT_TAG_PROMPT, EVENT_CONTENT_TAG_OUTPUT_SCHEMA, ACCEPTABLE_CONTENT_TAGS),
    twoStagePrompt(event.title, text, AMENITIES_TAG_PROMPT, EVENT_AMENITIES_TAG_OUTPUT_SCHEMA, ACCEPTABLE_AMENITIES_TAGS)
  ]);
  let results = formTags.concat(contentTags).concat(amenitiesTags.filter((tag) => tag !== "None"));
  results = [...new Set(results)];
  return results;
};