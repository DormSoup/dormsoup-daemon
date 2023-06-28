import assert from "assert";
import dedent from "dedent";
import dotenv from "dotenv";
import HttpStatus from "http-status-codes";
// import { RateLimiter } from "limiter-es6-compat";
import {
  ChatCompletionFunctions,
  Configuration,
  CreateChatCompletionRequest,
  OpenAIApi
} from "openai";

dotenv.config();
export const CURRENT_MODEL_NAME = "GPT-3.5-0624";

export interface Event {
  title: string;
  dateTime: Date;
  location: string;
  organizer: string;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
assert(OPENAI_API_KEY !== undefined, "OPENAI_API_KEY environment variable must be set");

const openai = new OpenAIApi(
  new Configuration({
    apiKey: OPENAI_API_KEY
  })
);

const PROMPT_INTRO = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  That email may or may not be advertising for one or multiple events. An event is defined as something that a group of MIT students could attend at a specific time and location (in or around MIT) typically lasting only a few hours.

  If the purpose of the email is to advertise for events, identify the following details of events:
  - The title of the event (up to five words. Use Title Case.)
  - The start time of the event (in HH:mm format)
  - The date_time of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor, the date received might help with your inference when the exact date is absent, use the time above)
  - The location of the event (MIT campus often use building numbers and room numbers to refer to locations. Be specific.)
  - The organization hosting the event (usually a club, however it is possible for individuals to organize events)

  The output should resemble the following:
  ---------------- Sample Response (for formatting reference) --------------
  {
    "events": [
      {
        "title": "UN x MIT: Immersive Storytelling",
        "time_in_the_day": 18:00,
        "date_time": "2023-04-03T18:00:00",
        "location": "Room 3-333",
        "organizer": "MIT UN"
      }
    ]
  }
  ---------------- End Sample Response (for formatting reference) --------------

  Common events include:
  - Talks
  - Shows

  However, if the purpose of the email is not to advertise for or inform about events, leave the value of events as an empty array.
  Cases where the email is not advertising for an event include:
  - Senior sales
  - Some individuals trying to resell tickets
  - Hiring staff (actors, volunteers) for upcoming events
  - Job applications
  
  If the information is not present in the email, leave the value as "unknown".

  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`;

/*

 */

//  An event is something that any MIT student could attend at a specific time and location, so if the email is about an audition, job opportunity, or seeking staff for a production, it is not an event.

const SHORT_MODEL = "gpt-3.5-turbo-0613";
const LONG_MODEL = "gpt-3.5-turbo-16k-0613";
const LONG_THRESHOLD = 12000; // 12k chars = 3k tokens
// const LIMITER = new RateLimiter({ tokensPerInterval: 10, interval: "second" });

const EXTRACT_FUNCTION: ChatCompletionFunctions = {
  name: "insert_extracted_properties_from_email",
  description: "Insert the extracted properties from the given email",
  parameters: {
    type: "object",
    properties: {
      rejectedReason: {
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
                "The date & time of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor, the date received might help with your inference when the exact date is absent)"
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
    required: ["events", "rejectedReason"]
  }
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
): Promise<Event[]> {
  // Get rid of shitty base64.
  body = removeBase64(body);

  let assembledPrompt = dedent`
    \`\`\`
    Subject: ${subject}
    Date Received: ${dateReceived}
    Body:
    ${body}
    \`\`\`                
  `;

  if (process.env.DEBUG_MODE) console.log("Assembled prompt:", assembledPrompt);

  const response = await createChatCompletionWithRetry({
    model: assembledPrompt.length > LONG_THRESHOLD ? LONG_MODEL : SHORT_MODEL,
    messages: [
      { role: "system", content: PROMPT_INTRO },
      { role: "user", content: assembledPrompt }
    ],
    functions: [EXTRACT_FUNCTION],
    function_call: { name: EXTRACT_FUNCTION.name }
  });

  const completion = response.data.choices[0];
  console.log("Completion:", completion);

  assert(
    completion.finish_reason === "stop" || completion.finish_reason === "function_call",
    "OpenAI API call failed"
  );
  let completionArguments = completion.message?.function_call?.arguments;
  assert(completionArguments !== undefined);
  if (process.env.DEBUG_MODE) {
    const rejectedReason = JSON.parse(completionArguments).rejectedReason;
    if (rejectedReason !== undefined) console.log("Rejected Reason: ", rejectedReason);
  }
  return tryParseEventJSON(completionArguments);
}

/**
 * Tries to parse the JSON response from the LLM.
 * This function does not throw. If anything goes wrong, it returns an empty Event object.
 *
 * @param completionText The completion text from LLM.
 * @returns An event object.
 */
function tryParseEventJSON(completionText: string): Event[] {
  try {
    const events: { [key: string]: string }[] = JSON.parse(completionText).events;
    return events.flatMap((rawEvent) => {
      try {
        const err = () => {
          throw new Error();
        };
        const dateTime = new Date(rawEvent["date_time"]);
        void dateTime.toISOString();
        return [
          {
            title: rawEvent["title"] ?? err(),
            dateTime,
            location: rawEvent["location"] ?? err(),
            organizer: rawEvent["organizer"] ?? err()
          } as Event
        ];
      } catch {
        return [];
      }
    });
  } catch (error) {
    console.log("Error: ", error);
    return [];
  }
}

async function createChatCompletionWithRetry(
  request: CreateChatCompletionRequest,
  backOffTimeMs: number = 1000
): ReturnType<typeof openai.createChatCompletion> {
  let response;
  while (true) {
    // const _ = await LIMITER.removeTokens(1);
    response = await openai.createChatCompletion(request, {
      validateStatus(status) {
        return true;
      }
    });
    if (response.status === HttpStatus.OK) break;
    if (
      response.status === HttpStatus.TOO_MANY_REQUESTS ||
      response.status === HttpStatus.SERVICE_UNAVAILABLE ||
      response.status === HttpStatus.BAD_GATEWAY
    ) {
      if (process.env.DEBUG_MODE) console.warn(`Rate limited. Retrying in ${backOffTimeMs} ms...`);
      await new Promise((resolve) => setTimeout(resolve, backOffTimeMs));
      backOffTimeMs *= 1.5;
      if (backOffTimeMs > 20000)
        throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    } else if (response.status === HttpStatus.BAD_REQUEST) {
      if (process.env.DEBUG_MODE) console.warn("Bad request: ", response);
    } else {
      throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    }
  }
  return response;
}

function removeBase64(input: string) {
  const startKeyword = ";base64,";
  const start = input.indexOf(";base64,");
  if (start === -1) return input;
  let end = start + startKeyword.length;
  while (end < input.length) {
    const charCode = input.charCodeAt(end);
    if (65 <= charCode && charCode <= 90) end++;
    else if (97 <= charCode && charCode <= 122) end++;
    else if (48 <= charCode && charCode <= 57) end++;
    else if (charCode === 43 || charCode === 47 || charCode === 61) end++;
    else break;
  }
  return removeBase64(input.slice(0, start) + input.slice(end));
}
