import { Event } from "@prisma/client";
import dedent from "dedent";
import { ChatCompletionFunctions } from "openai";

import { createChatCompletionWithRetry, removeArtifacts, removeBase64 } from "./utils.js";

export const CURRENT_MODEL_NAME = "TAG-0701";

const TAG_PROMPT = dedent`
  Given is an email sent by an MIT student to the dorm spam mailing list (i.e. to all MIT undergrads).
  The email has been identified to contain the following event:

  Title: {INSERT TITLE HERE}

  You need to identify whether the following tags can describe the event to help users use filters to find the events they want. Tags have three categories.
  - Event Form [Show, Talk, Movie Screening, Workshop, Rally, Showcase, Other]
  - Event Content:
  - Event Amenities:

  Each categories have their available tags.

  Event Form (choose one):
  - Show
  - Talk
  - Movie Screening
  - Workshop
  - Rally
  - Showcase
  - Study Break
  - Other

  Event Content (choose at most two):
  - EECS (Electrical Engineering and Computer Science)
  - AI
  - Math
  - Biology
  - HASS (Humanities, Arts, and Social Sciences) (Music & Dance has its own tag)
  - Music
  - Dance
  - Quant/Finance
  - Entrepreneurship
  - East Asian
  - FSILG (Fratertinies, Sororities, and Independent Living Groups)
  - Religion

  Event Amenities (if no amenities, leave this empty. If providing free food/boba to attendees, choose at most one. If both free food and boba, choose boba):
  - Food (only apply this tag if the event literally says it provides free food or snacks)
  - Boba
  If the event does not explictly say it provides free food or snacks or boba, please leave the Event Amenities empty.

  Email text:
`;

enum EventForm {
  SHOW = "Show",
  TALK = "Talk",
  MOVIE_SCREENING = "Movie Screening",
  WORKSHOP = "Workshop",
  RALLY = "Rally",
  SHOWCASE = "Showcase",
  STUDY_BREAK = "Study Break",
  OTHER = "Other"
}

enum EventContent {
  EECS = "EECS",
  AI = "AI",
  MATH = "Math",
  BIOLOGY = "Biology",
  HASS = "HASS",
  MUSIC = "Music",
  DANCE = "Dance",
  QUANT_FINANCE = "Quant/Finance",
  ENTREPRENEURSHIP = "Entrepreneurship",
  EAST_ASIAN = "East Asian",
  FSILG = "FSILG",
  RELIGION = "Religion"
}

enum EventAmenities {
  FREE_FOOD = "Food",
  BOBA = "Boba"
}

const EVENT_TAG_FUNCTION: ChatCompletionFunctions = {
  name: "tag_event",
  description: "Add tags to event",
  parameters: {
    type: "object",
    properties: {
      form_tag: {
        type: "string",
        description: "The tag of the form of the event.",
        enum: [
          "Show",
          "Talk",
          "Study Break",
          "Movie Screening",
          "Workshop",
          "Rally",
          "Showcase",
          "Other"
        ]
      },
      content_tag_1: {
        type: "string",
        description: "The first tag of the content of the event.",
        enum: [
          "EECS",
          "AI",
          "Math",
          "Biology",
          "HASS",
          "Music",
          "Dance",
          "Quant/Finance",
          "Entrepreneurship",
          "East Asian",
          "FSILG",
          "Religion"
        ]
      },
      content_tag_2: {
        type: "string",
        description: "The second tag of the content of the event.",
        enum: [
          "EECS",
          "AI",
          "Math",
          "Biology",
          "HASS",
          "Music",
          "Dance",
          "Quant/Finance",
          "Entrepreneurship",
          "East Asian",
          "FSILG",
          "Religion"
        ]
      },
      amenities_tag: {
        type: "string",
        description:
          "The tag of the amenities of the event. If there are both free food and boba, pick boba. If there is no free food, please leave this empty.",
        enum: ["Food", "Boba"]
      }
    },
    require: ["form_tag"]
  }
};

type EventTags = EventForm | EventContent | EventAmenities;

export async function addTagsToEvent(event: Event): Promise<EventTags[]> {
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

  const result = [];
  const isValid = (s: any): s is string =>
    s !== undefined && s !== null && typeof s === "string" && s.length > 0;
  if (isValid(response["form_tag"])) result.push(response["form_tag"]);
  const contentTag1 = response["content_tag_1"];
  const contentTag2 = response["content_tag_2"];
  if (isValid(contentTag1) && contentTag1.trim().toLowerCase() !== "other")
    result.push(contentTag1);
  if (isValid(contentTag2) && contentTag2.trim().toLowerCase() !== "other")
    result.push(contentTag2);
  if (isValid(response["amenities_tag"])) result.push(response["amenities_tag"]);
  return result as EventTags[];
}
