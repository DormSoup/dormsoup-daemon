import { Event } from "@prisma/client";
import dedent from "dedent";
import { ChatCompletionFunctions } from "openai";

import { createChatCompletionWithRetry, removeArtifacts, removeBase64 } from "./utils.js";

export const CURRENT_MODEL_NAME = "TAG-0701";

const TAG_PROMPT = dedent`
  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:

  Title: {INSERT TITLE HERE}

  You need to identify whether the following tags can describe the event to help users use filters to find the events they want. 
  
  Tags have three categories. Each categories have their available tags.

  Event Form (choose one):
  - Show
  - Concert
  - Talk
  - Movie Screening
  - Workshop
  - Rally (usually political)
  - Showcase (usually by some class, showcasing their projects)
  - Study Break (usually has the word study break in the email)
  - Other

  Event Content (choose at most two):
  - EECS (Electrical Engineering and Computer Science)
  - AI
  - Math
  - Biology
  - HASS (only pick HASS if the event is specifically acdemically about humanities, art, or social science) (Music & Dance has its own tag) 
  - Music
  - Dance
  - Quant/Finance
  - Entrepreneurship
  - East Asian (if the event is about East Asian culture)
  - FSILG (Fratertinies, Sororities, and Independent Living Groups)
  - Religion

  Event Amenities (if no amenities, leave this empty. If providing free food/boba to attendees, choose at most one. If both free food and boba, choose boba):
  - Food (only apply this tag if the event literally says it provides free food or snacks)
  - Boba
  If the event does not explictly say it provides free food or snacks or boba, please leave the Event Amenities empty.

  Email text:
`;

// enum EventForm {
//   SHOW = "Show",
//   TALK = "Talk",
//   MOVIE_SCREENING = "Movie Screening",
//   WORKSHOP = "Workshop",
//   RALLY = "Rally",
//   SHOWCASE = "Showcase",
//   STUDY_BREAK = "Study Break",
//   OTHER = "Other"
// }

// enum EventContent {
//   EECS = "EECS",
//   AI = "AI",
//   MATH = "Math",
//   BIOLOGY = "Biology",
//   HASS = "HASS",
//   MUSIC = "Music",
//   DANCE = "Dance",
//   QUANT_FINANCE = "Quant/Finance",
//   ENTREPRENEURSHIP = "Entrepreneurship",
//   EAST_ASIAN = "East Asian",
//   FSILG = "FSILG",
//   RELIGION = "Religion"
// }

// enum EventAmenities {
//   FREE_FOOD = "Food",
//   BOBA = "Boba"
// }

const EVENT_TAG_FUNCTION: ChatCompletionFunctions = {
  name: "tag_event_form",
  description: "Add form tags to event",
  parameters: {
    type: "object",
    description: "The tags for the form of the event (Choose exact one).",
    properties: {
      is_show: {
        type: "boolean",
        description: "Whether the event takes place in the form of a show."
      },
      is_concert: {
        type: "boolean",
        description: "Whether the event takes place in the form of a concert."
      },
      is_talk: {
        type: "boolean",
        description: "Whether the event takes place in the form of a talk."
      },
      is_study_break: {
        type: "boolean",
        description: "Whether the event is a study break."
      },
      is_movie_screening: {
        type: "boolean",
        description: "Whether the event takes place in the form of a movie screening."
      },
      is_workshop: {
        type: "boolean",
        description: "Whether the event takes place in the form of a workshop."
      },
      is_rally: {
        type: "boolean",
        description: "Whether the event takes place in the form of a rally."
      },
      is_showcase: {
        type: "boolean",
        description: "Whether the event takes place in the form of a showcase."
      },
      is_other: {
        type: "boolean",
        description: "Whether the event takes place in the form of something else."
      }
    },
    require: [
      "is_show",
      "is_concert",
      "is_talk",
      "is_study_break",
      "is_movie_screening",
      "is_workshop",
      "is_rally",
      "is_showcase",
      "is_other"
    ]
    /*
      content_tags: {
        type: "object",
        description: "The tags of the content of the event (choose at most two).",
        properties: {
          is_eecs: {
            type: "boolean",
            description: "Whether the event is related to MIT's Electrical Engineering and Computer Science department."
          },
          is_ai: {
            type: "boolean",
            description: "Whether the event is related to AI."
          },
          is_math: {
            type: "boolean",
            description: "Whether the event is related to math."
          },
          is_biology: {
            type: "boolean",
            description: "Whether the event is related to biology."
          },
          is_hass: {
            type: "boolean",
            description: "Whether the event is related to humanities, art, or social science."
          },
          is_music: {
            type: "boolean",
            description: "Whether the event is related to music."
          },
          is_dance: {
            type: "boolean",
            description: "Whether the event is related to dance."
          },
          is_quant_finance: {
            type: "boolean",
            description: "Whether the event is related to quant/finance."
          },
          is_entrepreneurship: {
            type: "boolean",
            description: "Whether the event is related to entrepreneurship."
          },
          is_east_asian: {
            type: "boolean",
            description: "Whether the event is related to East Asian culture."
          },
          is_fsilg: {
            type: "boolean",
            description: "Whether the event is affliated with a fraternity, sorority, or independent living group."
          },
          is_religion: {
            type: "boolean",
            description: "Whether the event is related to religion."
          }
        },
        require: [
          "is_eecs",
          "is_ai",
          "is_math",
          "is_biology",
          "is_hass",
          "is_music",
          "is_dance",
          "is_quant_finance",
          "is_entrepreneurship",
          "is_east_asian",
          "is_fsilg",
          "is_religion",
        ]
      },
      amenities_tag: {
        type: "object",
        description:
          "The tag of the amenities of the event. If there are both free food and boba, pick boba. If there is no free food, please leave this empty.",
        properties: {
          is_food: {
            type: "boolean",
            description: "Whether the event provides free food."
          },
          is_boba: {
            type: "boolean",
            description: "Whether the event provides free boba."
          }
        },
        require: ["is_food", "is_boba"]
      }
      */
    // },
    // require: ["form_tag" /*, "content_tags", "amenities_tag"*/]
  }
};

// type EventTags = EventForm | EventContent | EventAmenities;

export async function addTagsToEvent(event: Event): Promise<string[]> {
  const assembledSystemPrompt = TAG_PROMPT.replace("{INSERT TITLE HERE}", event.title);

  const response = await createChatCompletionWithRetry({
    model: "gpt-3.5-turbo-0613",
    messages: [
      { role: "system", content: assembledSystemPrompt },
      { role: "user", content: removeArtifacts(event.text) }
    ],
    functions: [EVENT_TAG_FUNCTION],
    function_call: { name: EVENT_TAG_FUNCTION.name }
  });

  console.log(response);

  // const result = [];
  // const isValid = (s: any): s is string =>
  //   s !== undefined && s !== null && typeof s === "string" && s.length > 0;
  // if (isValid(response["form_tag"])) result.push(response["form_tag"]);
  // const contentTag1 = response["content_tag_1"];
  // const contentTag2 = response["content_tag_2"];
  // if (isValid(contentTag1) && contentTag1.trim().toLowerCase() !== "other")
  //   result.push(contentTag1);
  // if (isValid(contentTag2) && contentTag2.trim().toLowerCase() !== "other")
  //   result.push(contentTag2);
  // if (isValid(response["amenities_tag"])) result.push(response["amenities_tag"]);
  // return result as EventTags[];
  return [];
}
