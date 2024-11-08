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

export interface Joke {
    title: string;
    rating: number;
    excerpt: string;
    punchline: string;
    rating_justification: string;
  }

  export interface JokeClassification {
    is_funny: boolean;
    rejected_reason: string;
  }

const PROMPT_INTRO_RETRIEVE_FUNNY_CLASSIFICATION = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email may or may not be "funny". An email is considered funny if it is written in a humorous way or has a clear pun or joke. 
  
  If the email is not offensive, insensitive, or controversial, respond False.
  Common offensive, insensitive, or controversial jokes are jokes that may be considered:
    - Sexist
    - Racist
    - Colorist
    - Dark

  If the email is funny or contains some joke, respond True.
  Common "funny" emails include:
  - Humorous Quotes
  - Puns

  Also, justify your classification (what about the email made you respond with True or False).

  The email you need to analyze is given below is delimited with triple backticks.

  Email text:
`

const PROMPT_INTRO_RETRIEVE_JOKE_OBJECT = dedent`
  Given in triple backticks is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  This email may or may not be considered to be "funny".

  If the "funny" part of the email can be easily identified, identify the following.
  - An excerpt of the "funny" part of the email, a direct 1-4 sentence quote from the email.
  - The email's punchline (an explanation of the why the funny part of the email is considered funny).
  - The title of the joke (Be Concise. Use Title Case.)
  - The email's funny rating (how funny the email is from 0.0 to 5.0)
  - The rating justification (justify your rating, what about the email made you respond with your rating).

Also, justify your rating (what about the email made you respond with your rating).
  The output should resemble the following:
  ---------------- Sample Response (for formatting reference) --------------
  {
    "joke":
      {
        "excerpt": "Why was six afraid of seven? Because seven eight nine.",
        "punchline": 'The joke “Why was six afraid of seven? Because seven eight nine” is a play on words using a pun and a double meaning. \
         The punchline hinges on the phrase "seven ate nine," which sounds like “seven eight nine,” as if it's counting in sequence (7, 8, 9). \
         However, the twist is that "ate" is actually implying that seven consumed (ate) nine, creating an absurd and humorous reason why six would be “afraid” of seven—because seven has become a dangerous number that "eats" other numbers!',
        "title": "7's Fear Of 9",
        "rating": 4.0,
        "rating_justification": The email has a nice joke that makes use of a play on words and double meaning.
      }
  }
  ---------------- End Sample Response (for formatting reference) --------------

  However, if the email is not funny, leave the value of joke as an empty object, and give reasons why (what about the email made you respond with an empty object).
  
  If the information is not present in the email, leave the value as "unknown".
`

const JOKE_CLASSIFICATION_PREDICATE_FUNCTION: ChatCompletionFunctions = {
    name: "classify_email",
    description: "Classify the email as funny or not funny",
    parameters:{
      type: "object",
      properties: {
        is_funny: {
          type: "boolean",
          description: "Whether the email is funny."
        },
        rejected_reason: {
          type: "string",
          description:
            "The reason why the email is not funny. (e.g. Why you don't consider the email to be funny). If the email is funny, leave this value as an empty string."
        }
      },
      require: ["is_funny", "rejected_reason"]
    }
  };
  
  const JOKE_EXTRACT_FUNCTION: ChatCompletionFunctions = {
    name: "insert_extracted_joke_properties_from_email",
    description: "Insert the extracted joke properties from the given email",
    parameters:{
      type: "object",
      properties:{
            excerpt: {
              type: "string",
              description:'The "funny" part of the email, a direct 1-4 sentence excerpt from the email.'
            },
            punchline: {
              type: "string",
              description: "The email's punchline (an explanation of the why the funny part of the email is considered funny)."
            }, 
            title: {
              type: "string",
              description: "The title of the joke (Be Concise. Use Title Case.)"
            },
            rating: {
                type: "number",
                description: "How funny the email is on a scale from 0.0 to 5.0",
                minimum: 0.0,
                maximum: 5.0
              },
              rating_justification: {
                type: "string",
                description:
                "The reason the email recieved the rating it did. (e.g. What about the email made you respond with your rating?)"
              },
          
        },
        required: ["excerpt", "punchline", "title", "rating", "rating_justification"]
      },
    };
  

export type ExtractJokeFromEmailResult =
{
    status: "rejected-by-gpt-4";
    reason: string;
}
| {
    status: "admitted";
    joke: Joke;
    }
| {
    status: "error-openai-network";
    error: any;
    }
| {
    status: "error-malformed-json";
    error: any;
    };

export async function extractJokeFromEmail(
subject: string,
body: string,
dateReceived: Date,
logger?: SpecificDormspamProcessingLogger
): Promise<ExtractJokeFromEmailResult> {
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

//   logger?.logBlock("assembled prompt", emailWithMetadata);

  let response;
  try {
    // logger?.logBlock("rate_joke prompt", PROMPT_INTRO_RETRIEVE_FUNNY_RATING);
    const isFunny = await createChatCompletionWithRetry({
      model: CHEAP_MODEL,
      messages: [
        { role: "system", content: PROMPT_INTRO_RETRIEVE_FUNNY_CLASSIFICATION },
        { role: "user", content: emailWithMetadata }
      ],
      functions: [JOKE_CLASSIFICATION_PREDICATE_FUNCTION],
      function_call: { name: JOKE_CLASSIFICATION_PREDICATE_FUNCTION.name }
    }) as JokeClassification;

    logger?.logBlock("rating response", JSON.stringify(isFunny));
    // console.log(responseIsEvent);
    if (!isFunny["is_funny"])
      return { status: "rejected-by-gpt-4", reason: isFunny.rejected_reason};

    // logger?.logBlock("extract prompt", PROMPT_INTRO_RETRIEVE_JOKE_OBJECT);
    response = await createChatCompletionWithRetry({
      model: MODEL,
      messages: [
        { role: "system", content: PROMPT_INTRO_RETRIEVE_JOKE_OBJECT },
        { role: "user", content: emailWithMetadata }
      ],
      functions: [JOKE_EXTRACT_FUNCTION],
      function_call: { name: JOKE_EXTRACT_FUNCTION.name }
    });
    logger?.logBlock("extract response", JSON.stringify(response));
  } catch (error) {
    return { status: "error-openai-network", error };
  }

  try {
    const joke = tryParseJokeJSON(response, logger);
    if (joke == null){
        return { status: "rejected-by-gpt-4", reason: "Parsing of Joke failed." };
    }
    return {
      status: "admitted",
      joke: joke
    };
  } catch (error) {
    return {
      status: "error-malformed-json",
      error
    };
  }
}

const err = (field: string) => {
    throw new Error(`Missing field ${field}`);
  };

const tryParseJokeJSON = (response: any, logger?: SpecificDormspamProcessingLogger): Joke | null =>{
    try{
        return {
            excerpt: response["excerpt"] ?? err("excerpt"),
            punchline: response["punchline"] ?? err("punchline"),
            rating: response["rating"] ?? err("rating"),
            title: response["title"] ?? err("title"),
            rating_justification: response["rating_justification"] ?? err("rating_justification"),
        }
    }
    catch(err){
        return null;
    }
}