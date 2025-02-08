import { JSONSchema7 } from "json-schema";
import {Event, PROMPT_INTRO, PROMPT_INTRO_HAS_EVENT} from "./emailToEvents.js";
import { doSIPBLLMsCompletionJSONSchema } from "./SIPBLLMsUtils.js";
import { SpecificDormspamProcessingLogger } from "../emailToEvents";
import { formatDateInET, removeArtifacts } from "./utils";
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

export const CURRENT_MODEL_NAME = "SIPBLLMs";

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
    return await doSIPBLLMsCompletionJSONSchema(PROMPT_INTRO_HAS_EVENT, emailWithMetadata, 
      HAS_EVENT_PREDICATE_OUTPUT_SCHEMA, "mixtral") as HasEventResponse;
  }
  
  /**
   * Extracts events from an email using SIPB LLMs.
   *
   * @param {string} emailWithMetadata - The email content along with its metadata.
   * @returns {Promise<ExtractEventsResponse>} A promise that resolves to an ExtractEventsResponse object containing the extracted events.
   */
  async function extractEvents(emailWithMetadata: string): Promise<ExtractEventsResponse>{
    return await doSIPBLLMsCompletionJSONSchema(PROMPT_INTRO, emailWithMetadata, 
      EXTRACT_EVENT_OUTPUT_SCHEMA, "deepseek-r1:32b") as ExtractEventsResponse;
  }

  /**
 * Extracts the event information from an email.
 *
 * @param subject the subject of the email
 * @param body the body of the email
 * @param dateReceived the date the email was received. This is used to infer the date of the event if the email does not contain the information.
 * @returns an Event object. If the email does not contain the information or the LLM made mistakes, the value is "unknown".
 */
export async function extractFromEmailSIPBLLMs(
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
      const events = tryParseEventJSON(response);
      if (events.length === 0)
        return { status: "rejected-by-sipb-llms-step-2", reason: response.rejected_reason };
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