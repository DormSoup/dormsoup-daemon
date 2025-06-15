import { JSONSchema7 } from "json-schema";
import { SIPBLLMs, SIPBLLMsChatModel } from "./SIPBLLMsUtils.js";
import { SpecificDormspamProcessingLogger } from "../emailToEvents.js";
import { formatDateInET, removeArtifacts } from "./utils.js";
import dedent from "dedent";

interface HasEventResponse {
  has_event: boolean;
  rejected_reason: string;
}

interface EventResponse {
  title: string;
  time_in_the_day?: string;
  date_time: string;
  duration?: string;
  location: string;
  organizer: string;
}

interface ExtractEventsResponse {
  rejected_reason: string;
  events: Array<EventResponse>;
}

export interface Event {
  title: string;
  dateTime: Date;
  location: string;
  organizer: string;
  duration: number;
}

export const CURRENT_SIPB_LLMS_EVENT_MODEL: SIPBLLMsChatModel =  "deepseek-r1:32b";
export const CURRENT_EVENT_MODEL_DISPLAY_NAME = `SIPBLLMs (${CURRENT_SIPB_LLMS_EVENT_MODEL})`;

const PROMPT_INTRO_HAS_EVENT = dedent`
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

const PROMPT_INTRO = dedent`
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

const HAS_EVENT_PREDICATE_OUTPUT_SCHEMA: JSONSchema7 = {
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
    required: ["has_event", "rejected_reason"]
};

const EXTRACT_EVENT_OUTPUT_SCHEMA: JSONSchema7 = {
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
          required: ["title", "date_time", "location", "organizer"]
        }
      }
    },
    required: ["events", "rejected_reason"]
  };

export type NonEmptyArray<T> = [T, ...T[]];

export type ExtractFromEmailResult =
  | {
      status: "rejected-by-sipb-llms";
      reason: string;
    }
  | {
      status: "admitted";
      events: NonEmptyArray<Event>;
    }
  | {
      status: "error-sipb-llms-network";
      error: any;
    }
  | {
      status: "error-malformed-json";
      error: any;
    }
  |
  {
      status: "rejected-by-sipb-llms-step-2"
      reason: string;
  };

/**
 * Tries to parse the JSON response from the LLM.
 * This function does not throw. If anything goes wrong, it returns an empty Event object.
 *
 * @param completionText The completion text from LLM.
 * @returns An event object.
 */
function tryParseEventJSON(response: ExtractEventsResponse): Event[] {
    const events: EventResponse[] = response.events;
    return events.flatMap((rawEvent) => {
      try {
        const err = (field: string) => {
          throw new Error(`Missing field ${field}`);
        };
        const dateTime = new Date(rawEvent["date_time"]);
        void dateTime.toISOString();
        const duration = rawEvent["duration"] ? parseInt(rawEvent["duration"]): 60;
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
  
  /**
 * Determines if an email contains an event using SIPB LLMs.
 *
 * @param emailWithMetadata - The email content along with its metadata.
 * @returns A promise that resolves to a `HasEventResponse` indicating whether the email contains an event.
 */
async function isEvent(emailWithMetadata: string): Promise<HasEventResponse>{
    return await SIPBLLMs(
      [
      { role: "system", content: PROMPT_INTRO_HAS_EVENT },
      { role: "user", content: emailWithMetadata }
      ],
      CURRENT_SIPB_LLMS_EVENT_MODEL,
      HAS_EVENT_PREDICATE_OUTPUT_SCHEMA) as HasEventResponse;
  }
  
/**
 * Extracts events from an email using SIPB LLMs.
 *
 * @param {string} emailWithMetadata - The email content along with its metadata.
 * @returns {Promise<ExtractEventsResponse>} A promise that resolves to an ExtractEventsResponse object containing the extracted events.
 */
async function extractEvents(emailWithMetadata: string): Promise<ExtractEventsResponse>{
  return await SIPBLLMs(
    [
    { role: "system", content: PROMPT_INTRO },
    { role: "user", content: emailWithMetadata }
    ],
    CURRENT_SIPB_LLMS_EVENT_MODEL, 
    EXTRACT_EVENT_OUTPUT_SCHEMA) as ExtractEventsResponse;
}

/**
 * Extracts event information from an email's subject, body, and received date.
 * 
 * This function processes the email content, checks if the email contains an event,
 * and attempts to extract structured event data using LLM-based prompts. It logs
 * various stages of the process if a logger is provided.
 * 
 * @param subject - The subject line of the email.
 * @param body - The body content of the email.
 * @param dateReceived - The date and time the email was received.
 * @param logger - (Optional) Logger for tracking processing steps and prompts.
 * @returns A promise that resolves to an `ExtractFromEmailResult` indicating the extraction status,
 *          extracted events (if any), or error information.
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
      const responseIsEvent: HasEventResponse = await isEvent(emailWithMetadata);
      logger?.logBlock("is_event response", JSON.stringify(responseIsEvent));
      if (!responseIsEvent["has_event"])
        return { status: "rejected-by-sipb-llms", reason: responseIsEvent["rejected_reason"] };
  
      logger?.logBlock("extract prompt", PROMPT_INTRO);
      response = await extractEvents(emailWithMetadata);
      logger?.logBlock("extract response", JSON.stringify(response));
    } catch (error) {
      return { status: "error-sipb-llms-network", error };
    }
  
    try {
      let events = tryParseEventJSON(response);
      if (events.length === 0) {
        response = await extractEvents(emailWithMetadata);
        events = tryParseEventJSON(response);
        if (events.length === 0)
          return { status: "rejected-by-sipb-llms-step-2", reason: response.rejected_reason };
      }
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