import { JSONSchema7 } from "json-schema";
import { SIPBLLMs } from "./SIPBLLMsUtils.js";
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

const PROMPT_INTRO_HAS_EVENT = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  That email may or may not be advertising for one or multiple events. An event is defined as something that a group of MIT students could attend at a specific time and location (in or around MIT) typically lasting only a few hours.

  If the purpose of the email is to advertise for events, respond True.

  Common events include:
  - Talks
  - Shows
  - Concerts
  - Performances
  - Film screenings
  - Workshops
  - Hackathons
  - Cultural celebrations
  - Club meetings
  - Conferences
  
  If the purpose of the email is not to advertise for or inform about events, respond False and give reasons why (what about the email made you respond false).
  Cases where the email is not advertising for an event include:
  - Senior sales
  - Individuals trying to resell tickets
  - Hiring staff (actors, volunteers) for upcoming events
  - Job applications
  - Lost and found
  - Housing or roommate searches
  - Selling personal items
  - General announcements with no specific date/time
  
  When evaluating, look for specific details about:
  1. A clear date and time
  2. A specific location
  3. An activity that multiple students can participate in

  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`;

const PROMPT_INTRO = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  That email may or may not be advertising for one or multiple events. An event is defined as something that a group of MIT students could attend at a specific time and location (in or around MIT) typically lasting only a few hours.

  If the purpose of the email is to advertise for events, extract the following details for EACH event mentioned:
  - The start time of the event (in HH:mm format, e.g., "18:00" for 6pm)
  - The date_time of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor. If an exact date isn't mentioned, infer it from context or use the date received. For example, if the event is "this Friday at 6pm" and today is 2023-04-01, use "2023-04-07T18:00:00.000Z")
  - The estimated duration of the event (an integer, number of minutes - use 60 if unspecified)
  - The location of the event (For MIT campus locations, use building numbers and room numbers like "26-100" not "Room 26-100". Be specific about room numbers when provided. No need to specify MIT if it is on MIT campus.)
  - The organization hosting the event (Be concise. Typically a club name, department, or individual organizers)
  - The title of the event (Use Title Case. If the organizer has a short name that provides context, include [ORGANIZER_NAME] before the title for clarity)

  The output should resemble the following:
  ---------------- Sample Response (for formatting reference) --------------
  {
    "events": [
      {
        "time_in_the_day": "18:00",
        "date_time": "2023-04-03T18:00:00.000Z",
        "duration": 90,
        "location": "3-333",
        "organizer": "MIT UN",
        "title": "[MIT UN] Immersive Storytelling"
      }
    ]
  }
  ---------------- End Sample Response (for formatting reference) --------------

  Common events include:
  - Talks and presentations
  - Shows and performances
  - Concerts and music events
  - Film screenings
  - Workshops and seminars
  - Hackathons
  - Cultural celebrations
  - Club meetings with guest speakers
  - Conferences and symposiums

  Pay special attention to:
  1. Emails may contain multiple events (create a separate event entry for each)
  2. Time expressions like "tomorrow", "next Monday", "this weekend" (convert these to actual dates)
  3. Location expressions specific to MIT (building numbers, named spaces)
  4. Recurring events (focus on the next occurrence)

  However, if the purpose of the email is not to advertise for or inform about events, leave the value of events as an empty array, and give reasons why (what about the email made you respond with empty array).
  
  Cases where the email is not advertising for an event include:
  - Senior sales or selling personal items
  - Individuals trying to resell tickets
  - Hiring staff (actors, volunteers) for upcoming events
  - Job applications
  - Lost and found
  - Housing or roommate searches
  - General announcements with no specific date/time
  
  If any specific field information is not present in the email, make a reasonable inference based on context. If you absolutely cannot determine a value, use "unknown" for string fields or reasonable defaults for others.

  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`;

export const CURRENT_MODEL_NAME = "SIPBLLMs (DeepSeek-R1-32B)";

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
      "deepseek-r1:32b",
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
     "deepseek-r1:32b", 
     EXTRACT_EVENT_OUTPUT_SCHEMA) as ExtractEventsResponse;
  }

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