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

const PROMPT_INTRO = dedent`
  Identify the following items from the email below:
  - Whether the email is inviting you to an event (true or false boolean value. For example, shows and talks are events, senior sales and club position applications are not events)
  - The title of the event (up to five words)
  - The dateTime of the event (in yyyy-MM-ddTHH:mm:ss format that can be recognized by JavaScript's Date constructor, the date received might help with your inference when the exact date is absent)
  - The location of the event
  - The organization hosting the event

  The email is delimited with triple backticks.
  Format your response as a JSON object with the following keys (just JSON, with no extra explanations):
  - "event"
  - "title"
  - "dateTime" (array format, if only one available time use array with only one element with no trailing comma, otherwise an array of multiple datetimes)
  - "location"
  - "organizer"

  If the information is not present in the email, leave the value as "unknown".

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

  const assembledPrompt = dedent`
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
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: PROMPT_INTRO },
          { role: "user", content: assembledPrompt }
        ]
      },
      { validateStatus: () => true }
    );
    if (response.status === HttpStatus.OK) break;
    if (response.status === HttpStatus.TOO_MANY_REQUESTS) {
      if (debugMode) console.warn(`Rate limited. Retrying in ${backOff} ms...`);
      await new Promise((resolve) => setTimeout(resolve, backOff));
      backOff *= 1.5;
    } else {
      throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    }
  }
  const completion = response.data.choices[0];
  assert(completion.finish_reason === "stop", "OpenAI API call failed");
  let completionText = completion.message?.content.trim();
  assert(completionText !== undefined);

  if (debugMode) console.log("Completion text:", completionText);

  return tryParseEventJSON(completionText);
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