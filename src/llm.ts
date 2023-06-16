import assert from "assert";
import dedent from "dedent";
import dotenv from "dotenv";
import HttpStatus from "http-status-codes";
import { Configuration, OpenAIApi } from "openai";

dotenv.config();
export const CURRENT_MODEL_NAME = "GPT-3.5-061223.12";

export class Event {
  public event: boolean = false;
  public title: string = "unknown";
  public dateTime: Date | Date[] = new Date();
  public location: string = "unknown";
  public organizer: string = "unknown";
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
assert(OPENAI_API_KEY !== undefined, "OPENAI_API_KEY environment variable must be set");

const openai = new OpenAIApi(
  new Configuration({
    apiKey: OPENAI_API_KEY
  })
);

const SHORT_PROMPT_INTRO = dedent`
  Identify the following items from the email below. 
  Output date time of an event in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor.

  The email is delimited with triple backticks.
  If any information is not present in the email, leave the value as "unknown".

  The output should resemble the following:
  \`\`\`
  {
    "events": [
      {
        "title": "[FREE FOOD] UN x MIT: Immersive storytelling and VR for Peace",
        "date_time": "2023-04-03T18:00:00",
        "location": "Room 3-333",
        "organizer": "MIT UN"
      }
    ]
  }
  \`\`\`

  Email text:
`;

const PROMPT_INTRO = dedent`
  Identify the following details of events from an email that will be given between triple backticks.
  - The title of the event (up to five words)
  - The start time of the event (in HH:mm format)
  - The date_time of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor, the date received might help with your inference when the exact date is absent, use the time above)
  - The location of the event
  - The organization hosting the event

  The output should resemble the following:
  ---------------- Sample Response (for formatting reference) --------------
  {
    "events": [
      {
        "title": "[FREE FOOD] UN x MIT: Immersive storytelling and VR for Peace",
        "time_in_the_day": 18:00,
        "date_time": "2023-04-03T18:00:00",
        "location": "Room 3-333",
        "organizer": "MIT UN"
      }
    ]
  }
  ---------------- End Sample Response (for formatting reference) --------------

  Note that in the above example, the date_time is given in the yyyy-MM-ddTHH:mm:ss format.
  The location is a specific location at or around MIT (MIT campus often use building numbers and room numbers to refer to locations), since this is an email sent by an MIT student, so generic location like Cambridge, MA is meaningless.
  The organizer is usually a club, however it is possible for individuals to organize events.
  What counts as events: shows and talks are events, senior sales and club position applications are not events)

  
  If the information is not present in the email, leave the value as "unknown".

  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`;


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
  debugMode: boolean = false
): Promise<Event> {
  let response;
  let backOff = 1000;

  // Get rid of shitty base64.
  body = body.replaceAll(/[A-Za-z0-9+\/=]{64,}/g, "");

  let assembledPrompt = dedent`
    \`\`\`
    Subject: ${subject}
    Date Received: ${dateReceived}
    Body:
    ${body}
    \`\`\`                
  `;

  if (debugMode) console.log("Assembled prompt:", assembledPrompt);

  while (true) {
    response = await openai.createChatCompletion(
      {
        model: "gpt-3.5-turbo-0613",
        // model: "gpt-3.5-turbo-16k-0613",
        messages: [
          { role: "system", content: PROMPT_INTRO },
          { role: "user", content: assembledPrompt }
        ],
        functions: [
          {
            name: "insert_extracted_properties_from_email",
            description: "Insert the extracted properties from the given email",
            parameters: {
              type: "object",
              properties: {
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
                        description:
                          "The start time in the day of the event (in HH:mm format)"
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
              required: ["events"]
            }
          }
        ],
        function_call: {
          name: "insert_extracted_properties_from_email"
        }
      },
      { validateStatus: () => true }
    );
    console.log("fuck", response); if (response.status === HttpStatus.OK) break;
    if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
      if (debugMode) console.warn(`Rate limited. Retrying in ${backOff} ms...`);
      await new Promise((resolve) => setTimeout(resolve, backOff));
      backOff *= 1.5;
    } else if (response.status === HttpStatus.BAD_REQUEST) {
      if (debugMode) console.warn("Bad requests: ", response);
      assembledPrompt = assembledPrompt.substring(0, assembledPrompt.length / 2) + "\`\`\`";
    } else {
      throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    }
  }
  const completion = response.data.choices[0];
  // console.log(completion);
  assert(
    completion.finish_reason === "stop" || completion.finish_reason === "function_call",
    "OpenAI API call failed"
  );
  let completionArguments = completion.message?.function_call?.arguments;
  assert(completionArguments !== undefined);
  console.log(completionArguments);
  throw new Error("fuck");
  // return tryParseEventJSON(completionArguments);
}

/**
 * Tries to parse the JSON response from the LLM.
 * This function does not throw. If anything goes wrong, it returns an empty Event object.
 *
 * @param completionText The completion text from LLM.
 * @returns An event object.
 */
function tryParseEventJSON(completionText: string): Event {
  let isEvent = false;
  try {
    // Removes surrounding ```s
    if (completionText.startsWith("```") && completionText.endsWith("```"))
      completionText = completionText.substring(3, completionText.length - 3);
    // Removes trailing comma (hacky)
    completionText = completionText.replaceAll(/,\s*\]/g, "]");

    const event: Event = JSON.parse(completionText);
    isEvent = event.event;
    // While theoretically the completion text should follow the schema of the Event object,
    // the object JSON.parse() isn't necessarily an actual Event object. We have to check here.
    for (const properties of Object.keys(new Event())) {
      assert(properties in event, `The key ${properties} is not present in the LLM response`);

      if (properties === "dateTime") {
        // Most notably for date time, since JSON does not have a date type, it always come in as
        // string(s).
        if (typeof event.dateTime === "string") {
          event.dateTime = new Date(event.dateTime as unknown as string);
          // Sanity check: try toISOString() to see if it's a valid date. Invalid dates will throw
          // RangeError here.
          void event.dateTime.toISOString();
        } else {
          event.dateTime = (event.dateTime as unknown as string[]).map((date) => new Date(date));
          event.dateTime.forEach((dateTime) => dateTime.toISOString());
        }
      }
    }
    return event;
  } catch (error) {
    // We only care about the error if the LLM thinks it's an event.
    // Non-events aren't added to the database for now anyways.
    if (isEvent) console.log("Cannot parse JSON:", completionText, error);
    return new Event();
  }
}
