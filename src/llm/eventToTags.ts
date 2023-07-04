import { Event } from "@prisma/client";
import dedent from "dedent";
import { ChatCompletionFunctions } from "openai";

import { createChatCompletionWithRetry, removeArtifacts, removeBase64 } from "./utils.js";

export const CURRENT_MODEL_NAME = "TAG-0703";

// PLAYsentation (Class Presentation), Logar(Concert), Alien Conspiracy
const FORM_TAG_PROMPT = dedent`
  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:

  Title: {INSERT TITLE HERE}

  The email body might contain multiple events, but you only need to identify the form tag for the event above.

  Start with the form of the event. Possible event forms (choose one):
  - Theater (like a play or a musical, relating to theater)
  - Concert
  - Talk (including workshops)
  - Movie Screening
  - Game
  - Rally
  - Class Presentation (usually by students demonstrating their class projects)
  - Study Break (relaxing event usually with food)
  - Other

  Only choose from tags given above. Think step by step and give reasons why you choose the tag you chose but not others.
`;

const CONTENT_TAG_PROMPT = dedent`
  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:
  
  Title: {INSERT TITLE HERE}

  The email body might contain multiple events, but you only need to identify the (up to two) content tags for the event above.
  
  The event's content focuses on (choose at most two):
  - EECS (Electrical Engineering and Computer Science)
  - AI
  - Math
  - Biology
  - HASS (specifically focusing the academic Humanities, Arts, and Social Sciences) (Music & Dance has its own tag)
  - Music
  - Dance
  - Quant/Finance
  - Entrepreneurship
  - East Asian
  - Religion
  - Queer (LGBTQ+)
  
  Only choose from tags given above. Think step by step and give reasons why you choose the tag you chose but not others.
`;

const AMENITIES_TAG_PROMPT = dedent`
  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:
  
  Title: {INSERT TITLE HERE}

  The email body might contain multiple events, but you only need to identify whether the event contains free food or boba.

  If the event provides free food or snacks, tag it with the type of food it provides.
  If the event provides boba, tag it with "Boba". If both free food and boba is provided, choose "Boba". 

  If no food or boba is given, feel free to leave this as none or null.
  
  Think step by step and give reasons why you (not) choose the tag you chose.
`;

const ACCEPTABLE_FORM_TAGS = [
  "Theater",
  "Concert",
  "Talk",
  "Study Break",
  "Movie Screening",
  "Game",
  "Rally",
  "Class Presentation",
  "Other"
];

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
  "HASS",
  "Music",
  "Dance",
  "Quant/Finance",
  "Entrepreneurship",
  "East Asian",
  "Religion",
  "Queer"
];

const EVENT_CONTENT_TAG_FUNCTION: ChatCompletionFunctions = {
  name: "tag_event_content",
  description: "Add content tag to event",
  parameters: {
    type: "object",
    properties: {
      content_tag_1: {
        type: "string",
        description: "The first tag of the content of the event.",
        enum: ACCEPTABLE_CONTENT_TAGS
      },
      content_tag_2: {
        type: "string",
        description: "The second tag of the content of the event (not necessary).",
        enum: ACCEPTABLE_CONTENT_TAGS
      }
    },
    require: ["content_tag_1"]
  }
};

const ACCEPTABLE_AMENITIES_TAGS = ["Free Food", "Boba", "None"];

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

export async function addTagsToEvent(event: Event): Promise<string[]> {
  const text = removeArtifacts(event.text);

  async function tryTwice(
    prompt: string,
    fn: ChatCompletionFunctions,
    allowed: string[]
  ): Promise<string[]> {
    const results: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await createChatCompletionWithRetry({
        model: "gpt-3.5-turbo-0613",
        messages: [
          { role: "system", content: prompt.replace("{INSERT TITLE HERE}", event.title) },
          { role: "user", content: text }
        ],
        functions: [fn],
        function_call: { name: fn.name }
      });
      if (response["type_of_food"] && !/boba|(bubble tea)/i.test(response["type_of_food"]))
        response["amenities_tag"] = "Free Food";
      for (let property in response)
        if (allowed.includes(response[property])) results.push(response[property]);
      if (results.length > 0) break;
    }
    return results;
  }

  const [formTags, contentTags, amenitiesTags] = await Promise.all([
    tryTwice(FORM_TAG_PROMPT, EVENT_FORM_TAG_FUNCTION, ACCEPTABLE_FORM_TAGS),
    tryTwice(CONTENT_TAG_PROMPT, EVENT_CONTENT_TAG_FUNCTION, ACCEPTABLE_CONTENT_TAGS),
    tryTwice(AMENITIES_TAG_PROMPT, EVENT_AMENITIES_TAG_FUNCTION, ACCEPTABLE_AMENITIES_TAGS)
  ]);

  let results = formTags.concat(contentTags).concat(amenitiesTags.filter((tag) => tag !== "None"));
  results = [...new Set(results)];  
  return results;
}
