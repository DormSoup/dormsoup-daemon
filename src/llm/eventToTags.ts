import { Event } from "@prisma/client";
import dedent from "dedent";

import { doCompletion } from "./emailToEvents.js";
import { removeArtifacts } from "./utils.js";

export const CURRENT_MODEL_NAME = "TAG-20241002";


// PLAYsentation (Class Presentation), Logar(Concert), Alien Conspiracy

const PROMPT_INTRO = dedent`
  You are a campus event tagger. Your job is to reason whether given tags apply to a specific event.

  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:

  Title: {INSERT TITLE HERE}

`;

const ACCEPTABLE_FORM_TAGS = [
  "Theater",
  "Concert",
  "Talk",
  "Study Break",
  "Movie Screening",
  "Game",
  "Sale",
  "Rally",
  "Dance",
  "Party",
  "Class Presentation"
];

const FORM_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify the form tag for the event above.

  Start with the form of the event. Possible event forms (choose the closest one) (after | is explanation, not part of tag):
  - Theater (like a play or a musical, relating to theater)
  - Concert
  - Talk | (including workshops)
  - Movie Screening
  - Game
  - Sale | (including fundraising)
  - Dance | (dance show or dance party)
  - Rally
  - Party | (including carnivals and festivals)
  - Class Presentation | (usually by students demonstrating their class projects)
  - Study Break | (relaxing event usually with food)

  Go through each tag above and give reasons whether each tag applies. Then finally give the tag you choose and why you choose it.

  Your answer must begin with: "Out of the the tags [${ACCEPTABLE_FORM_TAGS.join(", ")}]..."

  `;

const EVENT_FORM_TAG_GRAMMAR = dedent`
  form-tag ::= "\"Theater\"" | "\"Concert\"" | "\"Talk\"" | "\"Study Break\"" | "\"Movie Screening\"" | "\"Game\"" | "\"Sale\"" | "\"Rally\"" | "\"Dance\"" | "\"Party\"" | "\"Class Presentation\""
  form-tag-kv ::= "\"form_tag\"" space ":" space form-tag
  root ::= "{" space  (form-tag-kv )? "}" space
  space ::= " "?
`

const ACCEPTABLE_CONTENT_TAGS = [
  "EECS",
  "AI",
  "Math",
  "Biology",
  "Finance",
  "Career",
  "East Asian",
  "Religion",
  "Queer"
];

const CONTENT_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify the (up to two) content tags for the event above.

  The event's content focuses on (choose at most two, don't have to choose any if not relevant):
  - EECS | (Electrical Engineering and Computer Science)
  - AI
  - Math
  - Biology
  - Finance | (including Quant)
  - Career | (related to jobs and industries)
  - East Asian
  - Religion
  - Queer | (only if LGBTQ+ is specifically mentioned. Mentioning of a queer color doesn't count.)

  Go through each tag above and give reasons whether each tag applies. Then finally give the tag you choose and why you choose it (or why none applies).

  Your answer must begin with: "Out of the the tags [${ACCEPTABLE_CONTENT_TAGS.join(", ")}]..."
`;

const EVENT_CONTENT_TAG_GRAMMAR = dedent`
  content-tag-1 ::= "\"EECS\"" | "\"AI\"" | "\"Math\"" | "\"Biology\"" | "\"Finance\"" | "\"Career\"" | "\"East Asian\"" | "\"Religion\"" | "\"Queer\""
  content-tag-1-kv ::= "\"content_tag_1\"" space ":" space content-tag-1
  content-tag-1-rest ::= ( "," space content-tag-2-kv )?
  content-tag-2 ::= "\"EECS\"" | "\"AI\"" | "\"Math\"" | "\"Biology\"" | "\"Finance\"" | "\"Career\"" | "\"East Asian\"" | "\"Religion\"" | "\"Queer\""
  content-tag-2-kv ::= "\"content_tag_2\"" space ":" space content-tag-2
  root ::= "{" space  (content-tag-1-kv content-tag-1-rest | content-tag-2-kv )? "}" space
  space ::= " "?
`
const ACCEPTABLE_AMENITIES_TAGS = [
  "Free Food",
  "Boba"
];

const AMENITIES_TAG_PROMPT =
  PROMPT_INTRO +
  dedent`
  The email body might contain multiple events, but you only need to identify whether the specified event contains food or boba.

  If you think the email contains food, snacks, or boba, output the part of the email that indicates whether the event contains food or boba.

  If you think the email does not contain food, snacks, or boba, say why the event is unlikely to provide any edible items.

  At the end of your reasoning, suggest a tag from ["Free Food", "Boba", "None"]. (Pick boba if the event provides both)

  Your answer must begin with: "Out of the the tags [${ACCEPTABLE_AMENITIES_TAGS.join(", ")}]..."
`;

const EVENT_AMENITIES_TAG_GRAMMAR = dedent`
  amenities-tag ::= "\"Free Food\"" | "\"Boba\"" | "\"Food\"" | "\"None\""
  amenities-tag-kv ::= "\"amenities_tag\"" space ":" space amenities-tag
  amenities-tag-rest ::= ( "," space type-of-food-kv )?
  char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
  root ::= "{" space  (amenities-tag-kv amenities-tag-rest | type-of-food-kv )? "}" space
  space ::= " "?
  string ::= "\"" char* "\"" space
  type-of-food-kv ::= "\"type_of_food\"" space ":" space string
`

export async function addTagsToEvent(event: Event): Promise<string[]> {
  const text = removeArtifacts(event.text);

  const formTagPrompt = FORM_TAG_PROMPT.replace("{INSERT TITLE HERE}", event.title);
  const contentTagPrompt = CONTENT_TAG_PROMPT.replace("{INSERT TITLE HERE}", event.title);
  const amenitiesTagPrompt = AMENITIES_TAG_PROMPT.replace("{INSERT TITLE HERE}", event.title);

  const [formTags, contentTags, amenitiesTags] = await Promise.all([
    doCompletion(
      `${formTagPrompt}\n\`\`\`\n${text}\n\`\`\`\n\n---------------- Response --------------\n`,
      EVENT_FORM_TAG_GRAMMAR
    ),
    doCompletion(
      `${contentTagPrompt}\n\`\`\`\n${text}\n\`\`\`\n\n---------------- Response --------------\n`,
      EVENT_CONTENT_TAG_GRAMMAR
    ),
    doCompletion(
      `${amenitiesTagPrompt}\n\`\`\`\n${text}\n\`\`\`\n\n---------------- Response --------------\n`,
      EVENT_AMENITIES_TAG_GRAMMAR
    ),
  ]);

  const ACCEPTABLE_TAGS = ACCEPTABLE_FORM_TAGS.concat(ACCEPTABLE_CONTENT_TAGS).concat(ACCEPTABLE_AMENITIES_TAGS);
  return [formTags, contentTags, amenitiesTags]
    .flatMap(tags => Object.values(tags) as string[])
    .filter((tag) => ACCEPTABLE_TAGS.includes(tag));
}
