import dedent from "dedent";
import { ChatCompletionFunctions } from "openai";

import { SpecificDormspamProcessingLogger } from "../emailToEvents.js";
import {
  CHEAP_MODEL,
  MODEL,
  createChatCompletionWithRetry,
  formatDateInET,
  removeArtifacts
} from "./utils.js";

import { JSONSchema7 } from "json-schema";
import { doSIPBLLMsCompletionJSONSchema } from "./SIPBLLMsUtils.js";

export const CURRENT_MODEL_NAME = "GPT-4o-0901";

export interface Event {
  title: string;
  dateTime: Date;
  location: string;
  organizer: string;
  duration: number;
}

export const PROMPT_INTRO_HAS_EVENT = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  That email may or may not be advertising for one or multiple events. An event is defined as something that a group of MIT students could attend at a specific time and location (in or around MIT) typically lasting only a few hours.

  If the purpose of the email is to advertise for events, respond True.

  Common events include:
  - Talks
  - Shows
  
  If the purpose of the email is not to advertise for or inform about events, respond False and give reasons why (what about the email made you respond false).
  Cases where the email is not advertising for an event include:
  - Senior sales
  - Some individuals trying to resell tickets
  - Hiring staff (actors, volunteers) for upcoming events
  - Job applications
  
  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`;

export const PROMPT_INTRO = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  That email may or may not be advertising for one or multiple events. An event is defined as something that a group of MIT students could attend at a specific time and location (in or around MIT) typically lasting only a few hours.

  If the purpose of the email is to advertise for events, identify the following details of events:
  - The start time of the event (in HH:mm format)
  - The date_time of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor. If not mentioned, use time received. For example, if the event is at 6pm, use "2023-04-03T18:00:00.000Z", ignore timezone)
  - The estimated duration of the event (an integer, number of minutes, 60 is unspecified)
  - The location of the event (MIT campus often use building numbers and room numbers to refer to locations, in that case, just use numbers like "26-100" instead of "Room 26-100". Be specific. No need to specify MIT if it is on MIT campus.)
  - The organization hosting the event (Be Short. Usually a club, however it is possible for individuals to organize events)
  - The title of the event (Be Concise. Use Title Case. If organizer has a short name and provides context, include [ORGANIZER_NAME] before the title)

  The output should resemble the following:
  ---------------- Sample Response (for formatting reference) --------------
  {
    "events": [
      {
        "time_in_the_day": "18:00",
        "date_time": "2023-04-03T18:00:00.000Z",
        "duration": 90,
        "location": "3-333",
        "organizer": "MIT UN"
        "title": "[MIT UN] Immersive Storytelling",
      }
    ]
  }
  ---------------- End Sample Response (for formatting reference) --------------

  Common events include:
  - Talks
  - Shows

  However, if the purpose of the email is not to advertise for or inform about events, leave the value of events as an empty array, and give reasons why (what about the email made you respond with empty array),
  Cases where the email is not advertising for an event include:
  - Senior sales
  - Some individuals trying to resell tickets
  - Hiring staff (actors, volunteers) for upcoming events
  - Job applications
  
  If the information is not present in the email, leave the value as "unknown".

  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`;

const HAS_EVENT_PREDICATE_FUNCTION: ChatCompletionFunctions = {
  name: "set_email_has_event",
  description: "Decide if the email has events",
  parameters: {
    type: "object",
    properties: {
      has_event: {
        type: "boolean",
        description: "Whether the email contains any event."
      },
      rejected_reason: {
        type: "string",
        description:
          "The reason why the email does not contain any events. (e.g. Why you don't consider the email to be advertising for an event). If the email does contain events, leave this value as an empty string."
      }
    },
    require: ["has_event", "rejected_reason"]
  }
};

const EXTRACT_FUNCTION: ChatCompletionFunctions = {
  name: "insert_extracted_properties_from_email",
  description: "Insert the extracted properties from the given email",
  parameters: {
    type: "object",
    properties: {
      rejected_reason: {
        type: "string",
        description:
          "The reason why the email does not contain any events. (e.g. Why you don't consider the email to be advertising for an event). If the email does contain events, leave this value as an empty string."
      },
      events: {
        type: "array",
        description:
          "The events in the email. For example, shows and talks are events, senior sales and club position applications are not events.",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "The title of the event (up to five words)"
            },
            time_in_the_day: {
              type: "string",
              description: "The start time in the day of the event (in HH:mm format)"
            },
            date_time: {
              type: "string",
              description:
                "The date & time of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor, the date received might help with your inference when the exact date is absent), ignore time_zone i.e. if emails says 6pm just use 6pm UTC"
            },
            duration: {
              type: "integer",
              description: "The estimated duration of the event (an integer, number of minutes)"
            },
            location: {
              type: "string",
              description: "The location of the event"
            },
            organizer: {
              type: "string",
              description: "The organization hosting the event"
            }
          },
          required: ["title", "date", "location", "organizer"]
        }
      }
    },
    required: ["events", "rejected_reason"]
  }
};

export type NonEmptyArray<T> = [T, ...T[]];

export type ExtractFromEmailResult =
  | {
      status: "rejected-by-gpt-3";
      reason: string;
    }
  | {
      status: "rejected-by-gpt-4";
      reason: string;
    }
  | {
      status: "admitted";
      events: NonEmptyArray<Event>;
    }
  | {
      status: "error-openai-network";
      error: any;
    }
  | {
      status: "error-malformed-json";
      error: any;
    };

/**
 * Extracts the event information from an email.
 *
 * @param subject the subject of the email
 * @param body the body of the email
 * @param dateReceived the date the email was received. This is used to infer the date of the event if the email does not contain the information.
 * @returns an Event object. If the email does not contain the information or the LLM made mistakes, the value is "unknown".
 */
export async function extractFromEmail(
  subject: string,
  body: string,
  dateReceived: Date,
  logger?: SpecificDormspamProcessingLogger
): Promise<ExtractFromEmailResult> {
  body = removeArtifacts(body);

  let emailWithMetadata = dedent`
    \`\`\`
    Subject: ${subject}
    Date Received: ${formatDateInET(dateReceived)}
    Body:
    ${body}
    \`\`\`                
  `;

  if (process.env.DEBUG_MODE) console.log("Assembled prompt:", emailWithMetadata);

  logger?.logBlock("assembled prompt", emailWithMetadata);

  let response;

  try {
    logger?.logBlock("is_event prompt", PROMPT_INTRO_HAS_EVENT);
    const responseIsEvent = await createChatCompletionWithRetry({
      model: CHEAP_MODEL,
      messages: [
        { role: "system", content: PROMPT_INTRO_HAS_EVENT },
        { role: "user", content: emailWithMetadata }
      ],
      functions: [HAS_EVENT_PREDICATE_FUNCTION],
      function_call: { name: HAS_EVENT_PREDICATE_FUNCTION.name }
    });

    logger?.logBlock("is_event response", JSON.stringify(responseIsEvent));
    // console.log(responseIsEvent);
    if (!responseIsEvent["has_event"])
      return { status: "rejected-by-gpt-3", reason: responseIsEvent["rejected_reason"] };

    logger?.logBlock("extract prompt", PROMPT_INTRO);
    response = await createChatCompletionWithRetry({
      model: MODEL,
      messages: [
        { role: "system", content: PROMPT_INTRO },
        { role: "user", content: emailWithMetadata }
      ],
      functions: [EXTRACT_FUNCTION],
      function_call: { name: EXTRACT_FUNCTION.name }
    });
    logger?.logBlock("extract response", JSON.stringify(response));
  } catch (error) {
    return { status: "error-openai-network", error };
  }

  try {
    const events = tryParseEventJSON(response);
    if (events.length === 0 || response.rejected_reason)
      return { status: "rejected-by-gpt-4", reason: response.rejected_reason };
    return {
      status: "admitted",
      events: events as NonEmptyArray<Event>
    };
  } catch (error) {
    return {
      status: "error-malformed-json",
      error
    };
  }
}

/**
 * Tries to parse the JSON response from the LLM.
 * This function does not throw. If anything goes wrong, it returns an empty Event object.
 *
 * @param completionText The completion text from LLM.
 * @returns An event object.
 */
function tryParseEventJSON(response: any): Event[] {
  const events: { [key: string]: string }[] = response.events;
  return events.flatMap((rawEvent) => {
    try {
      const err = (field: string) => {
        throw new Error(`Missing field ${field}`);
      };
      const dateTime = new Date(rawEvent["date_time"]);
      void dateTime.toISOString();
      const duration = parseInt(rawEvent["duration"]);
      return [
        {
          title: rawEvent["title"] ?? err("title"),
          dateTime,
          location: rawEvent["location"] ?? err("location"),
          organizer: rawEvent["organizer"] ?? err("organizer"),
          duration: Number.isInteger(duration) ? duration : 60
        } as Event
      ];
    } catch {
      return [];
    }
  });
}