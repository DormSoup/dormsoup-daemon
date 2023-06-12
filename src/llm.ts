import assert from "assert";
import dedent from "dedent";
import dotenv from "dotenv";
import HttpStatus from "http-status-codes";
import { Configuration, OpenAIApi } from "openai";

dotenv.config();
export const CURRENT_MODEL_NAME = "GPT-3.5-051523";

export class Event {
    public event: boolean = false;
    public title: string = "unknown";
    public dateTime: Date = new Date();
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
    - "dateTime"
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
        } else
            throw new Error(`OpenAI API call failed with status ${response.status}: ${response}`);
    }
    const completion = response.data.choices[0];
    assert(completion.finish_reason === "stop", "OpenAI API call failed");
    const completionText = completion.message?.content;
    assert(completionText !== undefined);

    if (debugMode) console.log("Completion text:", completionText);

    try {
        const event: Event = JSON.parse(completionText);
        for (const properties of Object.keys(new Event())) {
            assert(properties in event, `The key ${properties} is not present in the LLM response`);
            if (properties === "dateTime") {
                event.dateTime = new Date(event.dateTime as unknown as string);
                void event.dateTime.toISOString();
            }
        }
        return event;
    } catch {
        console.log("Cannot parse JSON:", completionText);
        return new Event();
    }
}

// const testBody = `
// Hi everyone,

// Please join the MIT Ballroom Dance Team for some good company and fun dancing at our Spring Fling Social this Saturday, April 1st from 7-11 pm in La Sala de Puerto Rico at the Student Center (W20). There will be a beginner lesson from 7-8 pm followed by open dancing 8-11 pm. No prior dance experience or partner is necessary!

// See flyer below for more details. Hope to see you there!

// [cid:image003.png@01D96212.1757BE60]

// ---

// Courtney Lunger
// Publicity Coordinator
// MIT Ballroom Dance Team

// Bcc'ed to dorms, pink flower for bc-talk
// `;

// const testSubject = `[Macgregor] Spring Fling Social this Saturday, April 1st!`;
// const testDateReceived = new Date("2023-03-29T21:00:00.000Z");

// console.log(await extractFromEmail(testSubject, testBody, testDateReceived));
