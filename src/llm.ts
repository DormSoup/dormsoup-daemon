import assert from "assert";
import { ChatGPTAPI } from "chatgpt";
import dotenv from "dotenv";

dotenv.config();

const LIST_OF_PROPERTIES = ["Event", "Title", "Date", "Time", "Location", "Organizer"];
export type Event = {
    Event: boolean;
    Title: string;
    Date: string;
    Time: string;
    Location: string;
    Organizer: string;
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
assert(OPENAI_API_KEY !== undefined, "OPENAI_API_KEY environment variable must be set");
const api = new ChatGPTAPI({
    apiKey: OPENAI_API_KEY
});

const PROMPT_INTRO = `Identify the following items from the email below:
- Whether the email is inviting you to an event (true or false boolean value)
- The title of the event (up to five words)
- The date of the event (in mm/dd/yyyy format, the date received might help with your inference when the exact date is absent)
- The beginning time of the event (in hh:mm format, for example if the email mentions 9pm it should be 21:00)
- The location of the event
- The organization hosting the event

The email is delimited with triple backticks.
Format your response as a JSON object with the following keys:
- "Event"
- "Title"
- "Date"
- "Time"
- "Location"
- "Organizer"

If the information is not present in the email, leave the value as "unknown".

Email text:
`;

function assemblePrompt(subject: string, body: string, dateReceived: Date) {
    const prompt = `${PROMPT_INTRO}\`\`\`
Subject: ${subject}
Date Received: ${dateReceived}
Body:
${body}
\`\`\``;
    return prompt;
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
    dateReceived: Date
): Promise<Event> {
    const prompt = assemblePrompt(subject, body, dateReceived);

    const res = await api.sendMessage(prompt);
    try {
        const eventObj: Event = JSON.parse(res.text);
        for (const properties of LIST_OF_PROPERTIES) {
            assert(
                properties in eventObj,
                `The key ${properties} is not present in the LLM response`
            );
        }
        return eventObj;
    } catch (e) {
        console.log("Cannot parse JSON:", res.text);
        return {
            Event: false,
            Title: "unknown",
            Date: "unknown",
            Time: "unknown",
            Location: "unknown",
            Organizer: "unknown"
        };
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
